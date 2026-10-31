import { Type } from '@earendil-works/pi-ai';
import { defineTool, isToolCallEventType, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { boardText, moveText, play, replay } from '../business/engine';
import { analyzeExpert, compareMoves, MoveRiskError, reviewMove } from '../business/expert';
import { retrieveKnowledge } from '../business/knowledge';
import type { TurnPort } from '../business/game-service';
import { SKILLS_VERSION } from '../business/decision';
const point = Type.Object({ x: Type.Integer({ minimum: 0, maximum: 8 }), y: Type.Integer({ minimum: 0, maximum: 9 }) });
const move = { from: point, to: point };
export const XIANGQI_TOOLS = ['analyze_position', 'search_position', 'review_move', 'compare_moves', 'simulate_moves', 'update_plan', 'move_piece', 'resign_game', 'read_skill'];
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });
export interface SkillReader { names: string[]; read(name: string, reference?: string): string }
export function xiangqiExtension(port: TurnPort, skills: SkillReader, onRead: (id: string) => void, onFinish: () => void = () => {}): ExtensionFactory {
  return pi => {
    let calls = 0, committed = false;
    const active = () => { if (port.signal.aborted || committed) throw new Error('本回合已结束或取消'); };
    pi.on('tool_call', event => {
      active();
      // Exhausting analysis/skill budget must not remove the ability to finish.
      if (++calls > 16 && !['move_piece', 'resign_game'].includes(event.toolName)) return { block: true, reason: '单回合工具调用预算已耗尽；请落子或认输' };
      if (isToolCallEventType<'move_piece', { from: { x: number; y: number }; to: { x: number; y: number }; revision: number; reason: string }>('move_piece', event)) {
        port.log('extension', `校验走子：${moveText(event.input)} · revision ${event.input.revision}`);
      } else port.log('extension', `工具调用：${event.toolName}`);
      return undefined;
    });
    pi.registerTool(defineTool({
      name: 'read_skill', label: '读取技能全文', executionMode: 'sequential',
      description: 'Return one bundled skill by enum name, or a flat Markdown filename in its references directory.',
      parameters: Type.Object({ name: Type.Union(skills.names.map(name => Type.Literal(name))),
        reference: Type.Optional(Type.String({ pattern: '^[a-z0-9-]+\\.md$' })) }),
      async execute(_id, { name, reference }) {
        active(); const text = skills.read(name, reference);
        onRead(reference ? `${name}/${reference}` : name);
        return result({ version: SKILLS_VERSION, name, ...(reference ? { reference } : {}), text });
      },
    }));
    pi.registerTool(defineTool({
      name: 'analyze_position', label: '象棋局势计算', executionMode: 'sequential',
      description: 'Return revision, board, plan and full analysis including all legal moves, expert facts, candidates, coverage and limitations.',
      parameters: Type.Object({}),
      async execute() { active(); return result({ revision: port.state.revision, board: boardText(port.state.position), plan: port.state.plan, analysis: port.state.analysis.expert ? port.state.analysis : analyzeExpert(port.state.position) }); },
    }));
    pi.registerTool(defineTool({
      name: 'search_position', label: '有界多步对抗搜索', executionMode: 'sequential',
      description: 'Bounded search of all legal roots (omit moves) or 1–6 candidates. Returns depth, rootScope, principal variation, scores and coverage; no commit.',
      parameters: Type.Object({ moves: Type.Optional(Type.Array(Type.Object(move), { minItems: 1, maxItems: 6 })),
        maxMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })), maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })) }),
      async execute(_id, params, signal) {
        active(); if (signal?.aborted) throw new Error('搜索请求已取消');
        if (!port.search) throw new Error('未配置实战多步搜索端口');
        const search = await port.search(params, signal); active(); return result({ revision: port.state.revision, search });
      },
    }));
    pi.registerTool(defineTool({
      name: 'review_move', label: '专家走法审查', executionMode: 'sequential',
      description: 'Review one legal candidate. Returns counter-reply, estimatedNet, line, coverage, warnings and recalled cases; no commit.',
      parameters: Type.Object(move),
      async execute(_id, params) { active(); const review = reviewMove(port.state.position, params); return result({ revision: port.state.revision, review, experiences: port.recall?.(port.state.position, [review]) ?? [] }); },
    }));
    pi.registerTool(defineTool({
      name: 'compare_moves', label: '专家候选比较', executionMode: 'sequential',
      description: 'Compare 1–6 legal candidates with equal bounded budgets. Returns ranked reviews and recalled cases; no commit.',
      parameters: Type.Object({ moves: Type.Array(Type.Object(move), { minItems: 1, maxItems: 6 }) }),
      async execute(_id, params) { active(); const reviews = compareMoves(port.state.position, params.moves); return result({ revision: port.state.revision, reviews, experiences: port.recall?.(port.state.position, reviews) ?? [] }); },
    }));
    pi.registerTool(defineTool({
      name: 'simulate_moves', label: '变化试算', executionMode: 'sequential',
      description: 'Replay 1–6 supplied alternating legal moves on a copy. Returns board, terminal result and analysis; no commit.',
      parameters: Type.Object({ moves: Type.Array(Type.Object(move), { minItems: 1, maxItems: 6 }) }),
      async execute(_id, params) {
        active(); let p = replay(port.state.position.moves);
        for (const m of params.moves) p = play(p, m);
        const analysis = analyzeExpert(p, { candidateLimit: 6, maxMs: 40, maxNodes: 2500 });
        if (analysis.expert) { analysis.expert.knowledge = retrieveKnowledge(p, analysis.expert); analysis.expert.experiences = port.recall?.(p, analysis.expert.candidates) ?? []; }
        return result({ board: boardText(p), winner: p.winner, endReason: p.endReason, analysis });
      },
    }));
    pi.registerTool(defineTool({
      name: 'update_plan', label: '复核连续计划', executionMode: 'sequential',
      description: 'Stage a public plan: continue, revise (objective/problem/opponentThreat/1–3 nextSteps/abandonWhen), or abandon. Returns staged plan; saved with accepted move.',
      parameters: Type.Object({ action: Type.Union([Type.Literal('continue'), Type.Literal('revise'), Type.Literal('abandon')]),
        reason: Type.String({ minLength: 2, maxLength: 160 }), objective: Type.Optional(Type.String({ minLength: 2, maxLength: 160 })),
        problem: Type.Optional(Type.String({ minLength: 2, maxLength: 160 })), opponentThreat: Type.Optional(Type.String({ minLength: 2, maxLength: 160 })),
        nextSteps: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 120 }), { minItems: 1, maxItems: 3 })),
        abandonWhen: Type.Optional(Type.String({ minLength: 2, maxLength: 160 })) }),
      async execute(_id, params) {
        active(); if (!port.updatePlan) throw new Error('未配置连续计划端口');
        return result({ revision: port.state.revision, plan: port.updatePlan(params), staged: true });
      },
    }));
    pi.registerTool(defineTool({
      name: 'resign_game', label: '机器认输', executionMode: 'sequential',
      description: 'Voluntarily resign this game with current revision and a brief Chinese public reason. Immediately awards the human a win, saves reason, stops clocks and ends turn. No move required; do not sacrifice pieces or wait for timeout to resign.',
      parameters: Type.Object({ revision: Type.Integer({ minimum: 0 }), reason: Type.String({ minLength: 1, maxLength: 600 }) }),
      async execute(_id, params, signal) {
        active(); if (signal?.aborted) throw new Error('认输请求已取消');
        if (params.revision !== port.state.revision) throw new Error(`版本错误：当前 revision=${port.state.revision}`);
        if (!port.resign) throw new Error('未配置机器认输端口');
        await port.resign(params.reason, signal);
        committed = true; onFinish();
        return { ...result({ accepted: true, resigned: true }), terminate: true };
      },
    }));
    pi.registerTool(defineTool({
      name: 'move_piece', label: '移动棋子', executionMode: 'sequential',
      description: 'Submit from/to, current revision, Chinese public reason and optional 12–400 character riskAcknowledgement. Independently reviewed; returns accepted or risk error. Success ends turn.',
      parameters: Type.Object({ ...move, revision: Type.Integer({ minimum: 0 }), reason: Type.String({ minLength: 1, maxLength: 600 }),
        riskAcknowledgement: Type.Optional(Type.String({ minLength: 12, maxLength: 400, description: 'Concrete compensation or unavoidable loss for a reported risk.' })) }),
      async execute(_id, params, signal) {
        active(); if (signal?.aborted) throw new Error('落子请求已取消');
        if (params.revision !== port.state.revision) throw new Error(`版本错误：当前 revision=${port.state.revision}`);
        try { await port.commit(params, params.reason, params.riskAcknowledgement, signal); }
        catch (error) {
          if (!(error instanceof MoveRiskError)) throw error;
          return { content: [{ type: 'text' as const, text: error.message }], details: { review: error.review }, isError: true };
        }
        committed = true; onFinish();
        return { ...result({ accepted: true, move: moveText(params) }), terminate: true };
      },
    }));
  };
}
