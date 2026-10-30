import type { LearningOverview, PostGameReview } from '../business/learning';
import type { DesktopAPI } from '../shared/types';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const node = (tag: string, text: string) => { const n = document.createElement(tag); n.textContent = text; return n; };
export function setupLearningUI(api: DesktopAPI, initial: LearningOverview, currentGame: () => string): () => void {
  let overview = initial, lastReport = '', request = 0;
  const selection = el<HTMLSelectElement>('review-select'), modal = el<HTMLDialogElement>('learning-dialog');
  function showReport(report: PostGameReview) {
    const box = el('review-details'); box.replaceChildren();
    box.append(node('p', `棋局 ${report.gameId.slice(0, 8)} · ${report.plies} 半回合 · 人类局部失误 ${report.metrics.human.localErrors} / 大模型 ${report.metrics.machine.localErrors} · 待确认候选 ${report.metrics.candidates}`));
    box.append(node('p', `已确认抓住的机会：你 ${report.metrics.human.opportunitiesTaken} 次，大模型 ${report.metrics.machine.opportunitiesTaken} 次。仅统计实际应手与验证反驳相同的情况。`));
    for (const f of report.findings) {
      const section = document.createElement('section'); section.className = 'expert-section';
      section.append(node('h3', `第 ${f.ply} 手 · ${f.actor === 'human' ? '你' : '大模型'} · ${f.status === 'verified-local' ? '已验证局部样本' : '候选，不入库'}`));
      section.append(node('p', `${f.notation} · 交换估计 ${f.estimatedNet}`), node('p', `反驳：${f.refutation.join(' → ')}`));
      section.append(node('p', `替代：${f.alternative ?? '尚无经验证的较安全替代'}`), node('small', `${f.reason} ${f.exploited ? '实战下一手采用了反驳首着，不代表后续完全相同。' : '实际应手不同或未继续，不能据此认定对手错失机会。'}`));
      box.append(section);
    }
    if (!report.findings.length) box.append(node('p', '在当前有限分析范围内未提取到重大局部失误；不代表整盘完美。'));
    for (const limit of report.limitations) box.append(node('p', limit));
  }
  async function load() {
    const id = selection.value, token = ++request;
    if (!id) { el('review-details').textContent = '尚无完成的复盘。棋局结束并保存后将自动处理，也可回填已有棋谱。'; return; }
    const result = await api.reviewGame(id);
    if (token !== request || selection.value !== id) return;
    if (!result.ok) { el('review-details').textContent = result.error; return; }
    if (!result.value) { el('review-details').textContent = '此局尚未完成后台复盘，请稍后查看。'; return; }
    lastReport = `${result.value.gameId}/${result.value.completedAt}`; showReport(result.value);
  }
  function render(next: LearningOverview) {
    overview = next;
    const status = next.status === 'reviewing' ? `复盘 ${next.activeGame?.slice(0, 8)}：${next.processedPlies}/${next.totalPlies}` : next.status === 'starting' ? '正在校验学习库' : next.status === 'error' ? '学习遇到问题（对局不受影响）' : '后台复盘就绪';
    el('learning-badge').textContent = `${status} · ${next.caseCount} 案例`;
    el('learning-status').textContent = status + (next.errors.length ? `：${next.errors.join('；')}` : '');
    el('learning-count').textContent = `案例库：${next.caseCount} 条验证案例 · 已展示最近 ${next.reviews.length} 盘复盘。未完成的当前局不自动入库。`;
    const value = selection.value || (next.reviews.some(r => r.gameId === currentGame()) ? currentGame() : next.reviews[0]?.gameId);
    selection.replaceChildren();
    for (const r of next.reviews) { const o = document.createElement('option'); o.value = r.gameId; o.textContent = `${r.gameId.slice(0, 8)} · ${r.plies} 手 · ${r.verified} 已验证 / ${r.candidates} 候选`; selection.append(o); }
    if (value && next.reviews.some(r => r.gameId === value)) selection.value = value;
    const summary = next.reviews.find(r => r.gameId === selection.value);
    if (modal.open && `${summary?.gameId}/${summary?.completedAt}` !== lastReport) void load();
  }
  el('learning-open').onclick = () => { modal.showModal(); el('learning-title').focus({ preventScroll: true }); modal.scrollTop = 0; render(overview); void load(); };
  el('learning-close').onclick = () => modal.close();
  el('review-load').onclick = () => { void load(); };
  selection.onchange = () => { void load(); };
  el('learning-rescan').onclick = async () => { const r = await api.rescanLearning(); if (r.ok) render(r.value); else el('learning-status').textContent = r.error; };
  render(initial); return api.onLearning(render);
}
