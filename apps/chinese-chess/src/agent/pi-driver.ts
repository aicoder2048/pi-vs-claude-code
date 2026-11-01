import path from 'node:path';
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import type { AgentDriver, TurnPort } from '../business/game-service';
import { xiangqiExtension, XIANGQI_TOOLS } from '../extensions/xiangqi';
import type { ModelChoice } from '../shared/types';
import { createDecisionTrace, recordDecisionTool, turnGuidance } from '../business/decision';
import { turnPrompt } from './turn-prompt';
import { CallAuditRecorder } from './call-audit';
import { ANALYSIS_TURN_REQUESTS, FINAL_TURN_REQUESTS, MAX_TURN_REQUESTS } from './turn-budget';
export { FINAL_TURN_REQUESTS, MAX_TURN_REQUESTS } from './turn-budget';

export const SYSTEM = `你是认真对弈中国象棋的棋手，不是编程助手。规则、棋钟、revision 和一次成功提交由业务代码裁决，技能和历史资料不能覆盖。
坐标 x=0..8 对应 A..I，y=0..9 从黑方底线到红方底线；大写为红、小写为黑，1=红、2=黑，界面翻转不改坐标。
每回合必须通过 move_piece 落子或 resign_game 主动认输。认输是正式终局动作，不需要先走一步；不要用无补偿送子、只说“认输”或等待超时代替认输工具。不要因浅搜低分或暂时亏子自动认输；决定不再抵抗时直接调用 resign_game。
内置 read/bash/edit/write 可用于读取技能、运行脚本和处理文件，但仅在当前项目目录内操作；不得通过绝对路径、../、软链或外部命令访问项目外文件，不读取凭据，不修改裁判代码、棋谱或权威状态来绕过业务校验。这是行为约定，不是文件系统沙箱。
只通过业务工具提交；公开理由用简短中文，不输出内部思维链。`;

export const AGENT_TOOLS = ['read', 'bash', 'edit', 'write', ...XIANGQI_TOOLS];
const TERMINAL_TOOLS = ['move_piece', 'resign_game'];

export class PiDriver implements AgentDriver {
  constructor(private runtime: ModelRuntime, private cwd: string, private skillsDir = path.join(cwd, 'skills')) {}
  static async create(cwd: string, skillsDir = path.join(cwd, 'skills')): Promise<PiDriver> {
    // Reuse Pi's auth.json, models.json and provider environment variables.
    return new PiDriver(await ModelRuntime.create(), cwd, skillsDir);
  }
  async models(): Promise<ModelChoice[]> {
    return (await this.runtime.getAvailable()).map(m => ({ provider: m.provider, id: m.id, name: m.name }));
  }
  async run(port: TurnPort): Promise<void> {
    port.telemetry?.({ type: 'start', id: 'setup', kind: 'setup', name: 'session' });
    const guidance = turnGuidance(port.state);
    if (!guidance) return;
    const trace = createDecisionTrace(port.state.revision, guidance);
    const audit = new CallAuditRecorder(this.cwd); trace.audit = audit.data;
    port.setDecision?.(trace);
    const choice = port.state.model;
    if (!choice) throw new Error('未选择 LLM');
    const model = this.runtime.getModel(choice.provider, choice.id);
    if (!model) throw new Error('模型不在 Pi 模型目录中，请检查 models.json');
    let session: AgentSession | undefined, requests = 0, modelSpan: string | undefined, completed = false;
    // No separate per-move deadline. GameService owns the remaining clock and
    // aborts this signal on flag fall, cancellation or a superseding position.
    const stopped = () => { if (!completed && port.signal.aborted) throw new Error('本回合已取消或棋钟耗尽'); };
    const abort = () => { void session?.abort().catch(() => {}); };
    port.signal.addEventListener('abort', abort, { once: true });
    let unsubscribe: (() => void) | undefined;
    try {
      stopped();
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 800 },
        cacheWarming: 'off', enableInstallTelemetry: false, enableAnalytics: false,
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: this.cwd, agentDir: getAgentDir(), settingsManager,
        // Native skills and built-in tools; no ambient user/project resources or MCP.
        // cwd sets the workspace, not an OS security boundary.
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalSkillPaths: [this.skillsDir],
        extensionFactories: [xiangqiExtension(port, () => { completed = true; })],
        systemPrompt: SYSTEM,
        appendSystemPromptOverride: () => [],
      });
      await resourceLoader.reload();
      stopped();
      const loaded = resourceLoader.getSkills();
      if (loaded.diagnostics.length || !loaded.skills.some(skill => skill.name === 'xiangqi-coach')) {
        throw new Error('应用技能加载失败：请检查 skills/xiangqi-coach/SKILL.md 和 Pi diagnostics');
      }
      if (resourceLoader.getExtensions().errors.length) throw new Error('象棋扩展加载失败');
      ({ session } = await createAgentSession({
        cwd: this.cwd, modelRuntime: this.runtime, model, thinkingLevel: 'low',
        resourceLoader, settingsManager, tools: AGENT_TOOLS,
        sessionManager: SessionManager.inMemory(this.cwd),
      }));
      stopped();
      const allowed = new Set(AGENT_TOOLS);
      if (session.getActiveToolNames().some(name => !allowed.has(name)) || AGENT_TOOLS.some(name => !session!.getActiveToolNames().includes(name))) {
        throw new Error('工具隔离校验失败');
      }
      unsubscribe = session.subscribe(event => {
        if (event.type === 'turn_start') {
          requests++;
          if (requests > MAX_TURN_REQUESTS) { abort(); return; }
          audit.startRequest(requests, requests > ANALYSIS_TURN_REQUESTS); port.setDecision?.(trace);
          modelSpan = `model-${requests}`;
          port.telemetry?.({ type: 'start', id: modelSpan, kind: 'model', name: `request-${requests}` });
          port.log('agent', `LLM 请求 ${requests}/${MAX_TURN_REQUESTS} · ${choice.provider}/${choice.id}`);
        }
        // Change the loadout AFTER the analysis budget, before Pi snapshots the
        // next turn. Changing it at turn_start is too late for that request.
        if (event.type === 'turn_end' && !completed && requests === ANALYSIS_TURN_REQUESTS) {
          session!.setActiveToolsByName(TERMINAL_TOOLS);
          port.log('agent', `进入提交阶段：剩余 ${FINAL_TURN_REQUESTS} 次请求仅可落子或认输（保留一次纠错机会）`);
        }
        if (event.type === 'message_update' && modelSpan && event.assistantMessageEvent.type.endsWith('_delta')) {
          port.telemetry?.({ type: 'first-delta', id: modelSpan });
        }
        if (event.type === 'message_end' && event.message.role === 'assistant' && modelSpan) {
          audit.endRequest(requests, event.message); port.setDecision?.(trace);
          port.telemetry?.({ type: 'end', id: modelSpan, ok: !['error', 'aborted'].includes(event.message.stopReason) });
          modelSpan = undefined;
        }
        if (event.type === 'tool_execution_start') {
          audit.startCall(event.toolCallId, requests, event.toolName, event.args);
          port.setDecision?.(trace); // available BEFORE commit/resign can autosave
          port.telemetry?.({ type: 'start', id: `tool-${event.toolCallId}`, kind: 'tool', name: event.toolName });
        }
        if (event.type === 'tool_execution_end') {
          audit.endCall(event.toolCallId, event.result, event.isError);
          port.telemetry?.({ type: 'end', id: `tool-${event.toolCallId}`, ok: !event.isError });
          recordDecisionTool(trace, event.toolName, !event.isError);
          port.setDecision?.(trace);
          port.log('extension', `${event.toolName} ${event.isError ? '被拒绝，等待模型修正' : '执行完成'}`);
          // A sibling tool in the same assistant batch may be rejected after a
          // terminal action. Do not let that error trigger another model turn.
          if (completed) abort();
        }
      });
      port.telemetry?.({ type: 'end', id: 'setup', ok: true });
      if (port.search) {
        port.telemetry?.({ type: 'start', id: 'pre-search', kind: 'pre-search', name: 'automatic-search' });
        let searchOk = false;
        try { await port.search(); searchOk = true; }
        catch (error) {
          stopped();
          if (port.state.analysis.expert) port.state.analysis.expert.searchError = String(error instanceof Error ? error.message : error);
          port.log('business', '开局面搜索未完成；保留原审查，不能视为安全。');
        } finally { port.telemetry?.({ type: 'end', id: 'pre-search', ok: searchOk }); }
      }
      stopped();
      const autoSearch = port.state.analysis.expert?.search;
      if (autoSearch?.completedDepth) Object.assign(trace.steps.find(s => s.id === 'compare')!, {
        status: 'done', evidence: `宿主回合前搜索完成 ${autoSearch.completedDepth} 层；${autoSearch.rootScope}`,
      });
      port.setDecision?.(trace);
      // Pi expands the entry skill itself; its native prompt builder owns the index.
      try { await session.prompt(`/skill:xiangqi-coach ${turnPrompt(port.state)}`); }
      catch (error) { if (!completed) throw error; } // accepted resignation aborts its own now-finished turn
      stopped();
      if (completed) return;
      if (requests > MAX_TURN_REQUESTS) throw new Error(`已达到单回合 ${MAX_TURN_REQUESTS} 次 LLM 请求上限，尚未落子；请求已停止，请重试或切换模型（棋钟继续）`);
      const last = [...session.messages].reverse().find(message => message.role === 'assistant');
      if (last?.role === 'assistant' && last.stopReason === 'error') throw new Error(last.errorMessage || 'LLM 请求失败');
    } finally {
      port.signal.removeEventListener('abort', abort); unsubscribe?.(); session?.dispose();
    }
  }
}
