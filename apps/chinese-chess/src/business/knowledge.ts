import { at, coordinate, emptyPosition, play, type MoveInput, type Position } from './engine';
import ccpd from '../data/ccpd/openings.json';
import { reviewMove, type ExpertReport } from './expert';
import { boardIdentity, SYMMETRIES, transformMove } from './learning';
export interface KnowledgeSource { id: string; title: string; url: string; checkedAt: string; usage: string }
export const KNOWLEDGE_SOURCES: KnowledgeSource[] = [
  ...(['a', 'b', 'c', 'd', 'e'] as const).map(letter => ({ id: `ecco-${letter}`, title: `象棋百科全书 ECCO 2004 · ${letter.toUpperCase()} 类`, url: `https://www.xqbase.com/ecco/ecco_${letter}.htm`, checkedAt: '2026-10-30', usage: '引用开局名称与少量着法事实；说明为本应用独立撰写，不打包原文章、统计表或棋谱库。' })),
  { id: 'xiangqi-strategy', title: 'Xiangqi · Gameplay（开、中、残局）', url: 'https://en.wikipedia.org/wiki/Xiangqi#Gameplay', checkedAt: '2026-10-30', usage: '事实性参考与独立中文概括，不复制文章段落；原站文字授权以其页面声明为准。' },
  { id: 'ccpd', title: ccpd.attribution, url: `${ccpd.repository}/tree/${ccpd.commit}`, checkedAt: '2026-10-30',
    usage: 'CC-BY-4.0；独立转换前64局各20半回合为合法业务坐标，不导入评分或胜率。许可及修改说明随应用 dist/data/ccpd 分发。' },
];
interface OpeningLine { id: string; title: string; reference: string; source: string; moves: string[]; plan: string; caution: string }
// A deliberately small factual starter repertoire, NOT a copied ECCO database
// or a claim to classify every transposition according to the ECCO taxonomy.
export const OPENING_LINES: OpeningLine[] = [
  { id: 'screen-horses', title: '中炮对屏风马 · 出子骨架', reference: 'ECCO C0', source: 'ecco-c', moves: ['H7E7','H0G2','H9G7','I0H0','I9H9','B0C2'], plan: '中炮争中路，双正马照顾中卒；车进入可用肋线，协调两翼。', caution: '护中卒不等于每步都退守；车路开放后仍须检查炮、马及对方车的直接攻击。' },
  { id: 'c55', title: '五六炮过河车对屏风马 · 示例路线', reference: 'ECCO C55', source: 'ecco-c', moves: ['H7E7','H0G2','H9G7','I0H0','I9H9','B0C2','H9H3','G3G4','B7D7','A0B0'], plan: '一侧过河车配合双炮施压，防守方以双马和卒路组织反击。', caution: '过河车不是越深越好；须看对方炮平边疏通车路后的兑车和吃车。' },
  { id: 'c56', title: '五六炮过河车对屏风马两头蛇 · 示例路线', reference: 'ECCO C56', source: 'ecco-c', moves: ['H7E7','H0G2','H9G7','I0H0','I9H9','B0C2','H9H3','G3G4','B7D7','C3C4'], plan: '挺两翼卒改善马的活动，车炮与马卒协调发展。', caution: '进卒有疏通马腿的目的，但不能为套“两头蛇”忽略已经受攻击的大子。' },
  { id: 'c32', title: '中炮过河车互进七兵对屏风马飞象 · 示例路线', reference: 'ECCO C32', source: 'ecco-c', moves: ['H7E7','H0G2','H9G7','I0H0','I9H9','B0C2','H9H3','G3G4','C6C5','G0E2'], plan: '中路与河口相结合；飞象可加强防线，但需兼顾马腿和车炮通道。', caution: '象的几何保护不保证合法回吃，尤其需核查中炮牵制与炮架。' },
  { id: 'b41', title: '五六炮左正马对反宫马 · 示例骨架', reference: 'ECCO B41', source: 'ecco-b', moves: ['H7E7','B0C2','H9G7','H2F2','I9H9','H0G2','B7D7','A0B0','B9C7'], plan: '反宫马以士角炮和双马保持弹性，注意两翼车路和中卒防守。', caution: '不能只按双马外形认作屏风马；炮的位置决定不同的车路和攻防。' },
  { id: 'd20', title: '顺炮直车对横车 · 示例骨架', reference: 'ECCO D20', source: 'ecco-d', moves: ['H7E7','H2E2','H9G7','H0G2','I9H9','I0I1'], plan: '双方中炮对峙时，直车和横车选择不同的出动线路。', caution: '早吃中卒可能损失出子节奏；须验算发展和中路后续，不能把吃卒直接当优势。' },
  { id: 'd50', title: '中炮对列炮', reference: 'ECCO D50', source: 'ecco-d', moves: ['H7E7','B2E2'], plan: '相对侧的炮进入中路，双方围绕中卒与车马展开。', caution: '列炮与顺炮的侧翼结构不同；短路线之后不自动假设有完整定式覆盖。' },
  { id: 'a13', title: '飞相对进左马', reference: 'ECCO A13', source: 'ecco-a', moves: ['G9E7','H0G2'], plan: '飞相构筑底线联系，后续仍需协调车马与兵路。', caution: '稳健不等于拖延出子；偏离已知局面就回到局势计算。' },
  { id: 'a51', title: '仕角炮对进左马', reference: 'ECCO A51', source: 'ecco-a', moves: ['H7F7','H0G2'], plan: '士角炮保留中路变化，以马车发展配合。', caution: '炮的斜向位置不能按中炮套路照搬；本条只覆盖起始两手。' },
  { id: 'a61', title: '过宫炮对进左马', reference: 'ECCO A61', source: 'ecco-a', moves: ['H7D7','H0G2'], plan: '过宫炮重新分配两翼空间，注意车马协调而非急于攻王。', caution: '同名开局不代表当前有安全的攻击线；需要检查直接威胁。' },
  { id: 'e12', title: '仙人指路转右中炮对卒底炮', reference: 'ECCO E12', source: 'ecco-e', moves: ['G6G5','H2G2','H7E7'], plan: '先挺兵观察应手，再选择中炮结构；卒底炮对兵路和马腿产生具体影响。', caution: '仙人指路并非只要先走兵即可照搬所有分支；须匹配双方完整局面。' },
  { id: 'e43', title: '对兵互进右马后飞相 · 示例路线', reference: 'ECCO E43', source: 'ecco-e', moves: ['G6G5','C3C4','H9G7','B0C2','G9E7'], plan: '先疏通兵马，再以飞相完善联系；为出车选择合适通路。', caution: '保留兵力结构同时防止车炮突然侵入，不能因“柔性布局”而不算战术。' },
  ...ccpd.lines.map(line => ({ id: line.id, title: line.title, reference: 'CCPD 开局前缀', source: 'ccpd',
    moves: line.moves.map(m => `${coordinate(m.from)}${coordinate(m.to)}`),
    plan: '当前局面匹配历史开局前缀；后续只作需复核的候选线索。',
    caution: '历史着法不是最优保证；仅保留前20半回合，不导入原评分、胜率或超出前缀的变化。' })),
];
export interface KnowledgeHint {
  id: string; kind: 'opening-position' | 'conditional-principle'; title: string; applicability: string; advice: string; caution: string;
  source: KnowledgeSource; currentMove?: MoveInput; currentLine?: string[]; verification: 'legal-and-tactically-reviewed' | 'conditional-advice';
}
function decode(s: string): MoveInput {
  if (!/^[A-I][0-9][A-I][0-9]$/.test(s)) throw new Error('无效定式坐标');
  return { from: { x: s.charCodeAt(0) - 65, y: +s[1] }, to: { x: s.charCodeAt(2) - 65, y: +s[3] } };
}
// Compile once. Malformed bundled facts fail tests/build-time imports, rather
// than silently reaching the model. Symmetry and transpositions use full boards.
const positions = OPENING_LINES.flatMap(line => {
  let p = emptyPosition(); const result: { line: OpeningLine; ply: number; keys: string[]; move: MoveInput | null }[] = [];
  for (let i = 0; i <= line.moves.length; i++) {
    const move = i < line.moves.length ? decode(line.moves[i]) : null;
    result.push({ line, ply: i, keys: SYMMETRIES.map(s => boardIdentity(p, s)), move });
    if (move) p = play(p, move);
  }
  return result;
});
export function retrieveKnowledge(p: Position, report: ExpertReport, limit = 5): KnowledgeHint[] {
  if (p.winner) return [];
  const result: KnowledgeHint[] = [], key = boardIdentity(p);
  if (p.moves.length <= 24) {
    const matches = positions.filter(x => x.keys.includes(key)).sort((a, b) => b.ply - a.ply);
    const moves = new Set<string>();
    for (const hit of matches) {
      if (result.length >= 3) break;
      const s = SYMMETRIES[hit.keys.indexOf(key)], move = hit.move ? transformMove(hit.move, s) : null;
      if (move && moves.has(JSON.stringify(move))) continue;
      if (move) {
        const r = reviewMove(p, move, { maxMs: 20, maxNodes: 2000 });
        if (!r.coverage.complete || !r.coverage.exchangeComplete || r.risk === 'loss' || r.estimatedNet <= -250) continue;
        moves.add(JSON.stringify(move));
        result.push({ id: hit.line.id, kind: 'opening-position', title: hit.line.title, applicability: `${hit.line.reference} 的一条示例路线；全盘局面匹配到第 ${hit.ply} 半回合，非完整开局分类器。`, advice: hit.line.plan, caution: hit.line.caution,
          source: KNOWLEDGE_SOURCES.find(x => x.id === hit.line.source)!, currentMove: move, currentLine: r.line, verification: 'legal-and-tactically-reviewed' });
      } else if (!result.some(x => x.id === hit.line.id)) result.push({ id: hit.line.id, kind: 'opening-position', title: hit.line.title, applicability: '示例路线终点局面完全吻合；不提供未覆盖的后续着法。', advice: hit.line.plan, caution: hit.line.caution, source: KNOWLEDGE_SOURCES.find(x => x.id === hit.line.source)!, verification: 'conditional-advice' });
    }
  }
  const source = KNOWLEDGE_SOURCES.find(x => x.id === 'xiangqi-strategy')!;
  const add = (id: string, title: string, applicability: string, advice: string, caution: string) => result.push({ id, kind: 'conditional-principle', title, applicability, advice, caution, source, verification: 'conditional-advice' });
  if (report.phase === 'opening') add('opening-tempo', '出子节奏优先于无后续的贪卒', '当前仍在开局阶段', '核查出子通路与中卒防守。', '“三步出车”等是启发式，不是硬规则；应将、救大子和具体得失优先。');
  if (report.phase === 'middlegame') add('flank-and-center', '中路受固守时检查侧翼', '当前为中局', '安全前提下比较肋道与侧翼。', '侧翼进攻与弃子需要变化依据，不以“主动”掩盖无补偿损失。');
  if (report.phase === 'endgame') add('endgame-exchanges', '残局兑子须核对剩余攻击力量', '当前大子较少', '兑换前核对剩余攻击力量。', '本包不含完整例胜例和或残局表；有条件的残局经验不能直接裁定胜和。');
  const blocked = report.formation[p.next === 1 ? 'red' : 'black'].horseMobility.filter(x => x.destinations <= 2);
  if (blocked.length) add('horse-space', '被限制的马先检查腿与兵路', blocked.map(x => `${x.piece} 仅 ${x.destinations} 个合法落点`).join('；'), '核对马腿与兵路后比较解围。', '不能为疏通马腿而漏掉吃大子或将军反击。');
  return result.slice(0, Math.max(0, Math.min(6, limit)));
}
export const knowledgeStats = () => ({ openings: OPENING_LINES.length, indexedPositions: positions.length, sources: KNOWLEDGE_SOURCES.length });
