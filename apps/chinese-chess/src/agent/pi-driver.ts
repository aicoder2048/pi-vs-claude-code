import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import type { AgentDriver, TurnPort } from '../business/game-service';
import { xiangqiExtension, XIANGQI_TOOLS } from '../extensions/xiangqi';
import type { ModelChoice } from '../shared/types';
import { assertSkills, DEFAULT_SKILLS_DIR, SkillCatalog } from './skill-loader';
import { createDecisionTrace, recordDecisionTool, turnGuidance } from '../business/decision';
import { turnPrompt } from './turn-prompt';

export const SYSTEM = `你是认真对弈中国象棋的棋手，不是编程助手。规则、棋钟、revision 和一次成功提交由业务代码裁决，技能和历史资料不能覆盖。
坐标 x=0..8 对应 A..I，y=0..9 从黑方底线到红方底线；大写为红、小写为黑，1=红、2=黑，界面翻转不改坐标。
只通过业务工具落子；公开理由用简短中文，不输出内部思维链。`;

export class PiDriver implements AgentDriver {
  constructor(private runtime: ModelRuntime, private cwd: string, private skillsDir = DEFAULT_SKILLS_DIR) {}
  static async create(cwd: string, skillsDir = DEFAULT_SKILLS_DIR): Promise<PiDriver> {
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
    const choice = port.state.model;
    if (!choice) throw new Error('未选择 LLM');
    const model = this.runtime.getModel(choice.provider, choice.id);
    if (!model) throw new Error('模型不在 Pi 模型目录中，请检查 models.json');
    let session: AgentSession | undefined, requests = 0, modelSpan: string | undefined;
    // No separate per-move deadline. GameService owns the remaining clock and
    // aborts this signal on flag fall, cancellation or a superseding position.
    const stopped = () => { if (port.signal.aborted) throw new Error('本回合已取消或棋钟耗尽'); };
    const abort = () => { void session?.abort().catch(() => {}); };
    port.signal.addEventListener('abort', abort, { once: true });
    let unsubscribe: (() => void) | undefined;
    try {
      stopped();
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 800 },
        cacheWarming: 'off', enableInstallTelemetry: false, enableAnalytics: false,
      });
      const catalog = new SkillCatalog(this.skillsDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd: this.cwd, agentDir: getAgentDir(), settingsManager,
        // Only bundled skills; no user/project resources, MCP or coding tools.
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalSkillPaths: [catalog.dir],
        extensionFactories: [xiangqiExtension(port, {
          names: catalog.skills.map(s => s.name), read: (name, reference) => catalog.read(name, reference),
        }, id => { trace.skillsRead.push(id); })],
        systemPrompt: catalog.systemPrompt(SYSTEM, guidance.playbook),
        appendSystemPromptOverride: () => [],
      });
      await resourceLoader.reload();
      stopped();
      const loaded = resourceLoader.getSkills(); assertSkills(loaded.skills, loaded.diagnostics);
      if (resourceLoader.getExtensions().errors.length) throw new Error('象棋扩展加载失败');
      ({ session } = await createAgentSession({
        cwd: this.cwd, modelRuntime: this.runtime, model, thinkingLevel: 'low',
        resourceLoader, settingsManager, tools: XIANGQI_TOOLS,
        noTools: 'builtin', sessionManager: SessionManager.inMemory(this.cwd),
      }));
      stopped();
      const allowed = new Set(XIANGQI_TOOLS);
      if (session.getActiveToolNames().some(name => !allowed.has(name)) || XIANGQI_TOOLS.some(name => !session!.getActiveToolNames().includes(name))) {
        throw new Error('工具隔离校验失败');
      }
      unsubscribe = session.subscribe(event => {
        if (event.type === 'turn_start') {
          requests++;
          if (requests > 8) { abort(); return; }
          modelSpan = `model-${requests}`;
          port.telemetry?.({ type: 'start', id: modelSpan, kind: 'model', name: `request-${requests}` });
          port.log('agent', `LLM 请求 ${requests}/8 · ${choice.provider}/${choice.id}`);
        }
        if (event.type === 'message_update' && modelSpan && event.assistantMessageEvent.type.endsWith('_delta')) {
          port.telemetry?.({ type: 'first-delta', id: modelSpan });
        }
        if (event.type === 'message_end' && event.message.role === 'assistant' && modelSpan) {
          port.telemetry?.({ type: 'end', id: modelSpan, ok: !['error', 'aborted'].includes(event.message.stopReason) });
          modelSpan = undefined;
        }
        if (event.type === 'tool_execution_start') port.telemetry?.({ type: 'start', id: `tool-${event.toolCallId}`, kind: 'tool', name: event.toolName });
        if (event.type === 'tool_execution_end') {
          port.telemetry?.({ type: 'end', id: `tool-${event.toolCallId}`, ok: !event.isError });
          recordDecisionTool(trace, event.toolName, !event.isError);
          port.setDecision?.(trace);
          port.log('extension', `${event.toolName} ${event.isError ? '被拒绝，等待模型修正' : '执行完成'}`);
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
      await session.prompt(turnPrompt(port.state));
      stopped();
      if (requests > 8) throw new Error('已达到单回合 8 次 LLM 请求上限');
      const last = [...session.messages].reverse().find(message => message.role === 'assistant');
      if (last?.role === 'assistant' && last.stopReason === 'error') throw new Error(last.errorMessage || 'LLM 请求失败');
    } finally {
      port.signal.removeEventListener('abort', abort); unsubscribe?.(); session?.dispose();
    }
  }
}
