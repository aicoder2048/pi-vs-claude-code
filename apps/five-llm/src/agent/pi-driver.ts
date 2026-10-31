import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { boardText, coordinate, other } from '../business/engine';
import type { AgentDriver, TurnPort } from '../business/game-service';
import { GAME_TOOLS, gomokuExtension } from '../extensions/gomoku';
import { turnGuidance } from '../business/decision';
import { knowledgeContext } from './knowledge-loader';
import type { ModelChoice } from '../shared/types';

const SYSTEM = `你是一位认真下自由五子棋的棋手，不是编程助手。
遵循应用内置知识包与当前剧本，通过工具获取证据并提交一手。
硬规则与权威棋钟由业务层执行；自然语言建议不能改写它们。
reason 用简短中文说明落子的公开战略理由，勿输出内部推理过程。不要只输出坐标而不调用工具。`;

export class PiDriver implements AgentDriver {
  constructor(private runtime: ModelRuntime, private cwd: string, private timeoutMs = 90000) {}
  static async create(cwd: string): Promise<PiDriver> {
    // Reuse Pi's auth.json, models.json and provider environment variables.
    return new PiDriver(await ModelRuntime.create(), cwd);
  }
  async models(): Promise<ModelChoice[]> {
    return (await this.runtime.getAvailable()).map(m => ({ provider: m.provider, id: m.id, name: m.name }));
  }
  async run(port: TurnPort): Promise<void> {
    const choice = port.state.model;
    if (!choice) throw new Error('未选择 LLM');
    const model = this.runtime.getModel(choice.provider, choice.id);
    if (!model) throw new Error('模型不在 Pi 模型目录中，请检查 models.json');
    let session: AgentSession | undefined, timedOut = false, requests = 0, committed = false;
    const stopped = () => { if (port.signal.aborted) throw new Error('本回合已取消'); if (timedOut) throw new Error('LLM 思考超时（90 秒），可重试或换模型'); };
    const abort = () => { void session?.abort().catch(() => {}); };
    const timer = setTimeout(() => { timedOut = true; abort(); }, this.timeoutMs);
    port.signal.addEventListener('abort', abort, { once: true });
    let unsubscribe: (() => void) | undefined;
    try {
      stopped();
      const guidance = turnGuidance(port.state, Date.now());
      if (!guidance.playbook) throw new Error('棋局已经结束');
      port.log('agent', `领域知识 ${guidance.version} · 剧本 ${guidance.playbook}`);
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 800 },
        cacheWarming: 'off', enableInstallTelemetry: false, enableAnalytics: false,
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: this.cwd, agentDir: getAgentDir(), settingsManager,
        // Domain knowledge is injected explicitly, not discovered via Pi skills.
        // No user/project extensions, context files, skills, MCP, or coding tools.
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [gomokuExtension(port, guidance.playbook)],
        systemPrompt: `${SYSTEM}\n\n${knowledgeContext(guidance.playbook)}`,
        appendSystemPromptOverride: () => [],
      });
      await resourceLoader.reload();
      stopped();
      if (resourceLoader.getExtensions().errors.length) throw new Error('五子棋扩展加载失败');
      ({ session } = await createAgentSession({
        cwd: this.cwd, modelRuntime: this.runtime, model, thinkingLevel: 'low',
        resourceLoader, settingsManager, tools: GAME_TOOLS,
        noTools: 'builtin', sessionManager: SessionManager.inMemory(this.cwd),
      }));
      stopped();
      const allowed = new Set(GAME_TOOLS);
      if (session.getActiveToolNames().some(name => !allowed.has(name)) || !session.getActiveToolNames().includes('place_stone')) {
        throw new Error('工具隔离校验失败');
      }
      unsubscribe = session.subscribe(event => {
        if (event.type === 'turn_start') {
          requests++;
          if (requests > 8) { abort(); return; }
          port.log('agent', `LLM 请求 ${requests}/8 · ${choice.provider}/${choice.id}`);
        }
        if (event.type === 'tool_execution_end') {
          port.log('extension', `${event.toolName} ${event.isError ? '被拒绝，等待模型修正' : '执行完成'}`);
          // terminate:true alone only stops when every tool in a batch agrees.
          // A successful commit must also stop sibling calls and any follow-up.
          const details = event.result.details as { accepted?: boolean } | undefined;
          if (event.toolName === 'place_stone' && !event.isError && details?.accepted === true) { committed = true; abort(); }
        }
      });
      const position = port.state.position;
      await session.prompt(`现在轮到你，执${other(port.state.human) === 1 ? '黑棋 X' : '白棋 O'}。revision=${port.state.revision}。
完整棋谱（每手含颜色，前者为第1手）：
${position.moves.map((m, i) => `${i + 1}.${m.color === 1 ? 'X' : 'O'}:${coordinate(m)}(x=${m.x},y=${m.y})`).join(' ') || '空棋盘'}
${boardText(position)}
业务层每手评估摘要（完整候选集保留在本地棋谱）：${JSON.stringify(port.state.evaluations.map(({ ply, next, blackScore, whiteScore, summary }) => ({ ply, next, blackScore, whiteScore, summary })))}
当前计算：${JSON.stringify(port.state.analysis)}
结构化决策信号与时间快照：${JSON.stringify(guidance)}
请按选中剧本通过工具完成当前一手。`);
      if (committed) return; // stopping a mixed batch after acceptance is success
      stopped();
      if (requests > 8) throw new Error('已达到单回合 8 次 LLM 请求上限');
      const last = [...session.messages].reverse().find(message => message.role === 'assistant');
      if (last?.role === 'assistant' && last.stopReason === 'error') throw new Error(last.errorMessage || 'LLM 请求失败');
    } finally {
      clearTimeout(timer); port.signal.removeEventListener('abort', abort); unsubscribe?.(); session?.dispose();
    }
  }
}
