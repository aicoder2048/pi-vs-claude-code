/** Headless: real GameService + real PiDriver (real pi, openai-codex), with a stacked shoe per scenario. Human bets 10 and always stands. */
const APP = "/Users/szou/Python/Playground/DoorBird/Apps/blackjack";
const { GameService } = await import(`${APP}/src/business/game-service.ts`);
const { createGame } = await import(`${APP}/src/business/rules.ts`);
const { loadConfig } = await import(`${APP}/src/agent/config.ts`);
const { PiDriver } = await import(`${APP}/src/agent/driver.ts`);

type R = string;
// [aiCard1, aiCard2, dealerUp, then optional next cards drawn after the deal]
const scenarios: { name: string; ai: [R, R]; up: R; hole: R; next: R[] }[] = [
	{ name: "8,8 对 6（基本策略：分牌）", ai: ["8", "8"], up: "6", hole: "10", next: ["3", "10", "2", "9"] },
	{ name: "A,A 对 7（基本策略：分牌）", ai: ["A", "A"], up: "7", hole: "10", next: ["K", "9"] },
	{ name: "5,6=硬11 对 6（基本策略：加倍）", ai: ["5", "6"], up: "6", hole: "10", next: ["9"] },
	{ name: "A,7=软18 对 4（基本策略：加倍）", ai: ["A", "7"], up: "4", hole: "10", next: ["2"] },
	{ name: "10,10 对 6（基本策略：停牌，不分）", ai: ["10", "K"].slice(0, 1).concat(["10"]) as [R, R], up: "6", hole: "10", next: ["5"] },
	{ name: "9,9 对 7（基本策略：停牌）", ai: ["9", "9"], up: "7", hole: "10", next: ["5", "8"] },
];
const only = process.argv[2] ? process.argv[2].split(",").map(Number) : scenarios.map((_, i) => i);

function stacked(s: (typeof scenarios)[number]) {
	const g = createGame();
	const take = (rank: R) => { const i = g.shoe.cards.findIndex((c: any) => c.rank === rank); if (i < 0) throw new Error(rank); return g.shoe.cards.splice(i, 1)[0]; };
	// deal order: human, ai, dealerUp, human, ai, dealerHole
	const top = [take("7"), take(s.ai[0]), take(s.up), take("10"), take(s.ai[1]), take(s.hole), ...s.next.map(take)];
	g.shoe.cards.unshift(...top);
	return g;
}
const fmt = (cards: any[]) => cards.map((c) => (c ? c.rank + c.suit : "??")).join(" ");
const config = loadConfig(APP);
console.log("model:", config.model);

for (const i of only) {
	const s = scenarios[i];
	const t0 = Date.now();
	console.log(`\n=== 场景 ${i + 1}: ${s.name} ===`);
	const service = new GameService({ driver: new PiDriver(config), model: config.model, initial: stacked(s) });
	const view: any = await new Promise((done) => {
		let busy = false;
		const timer = setTimeout(() => done({ timeout: true, ...service.view() }), 6 * 60_000);
		service.subscribe((v: any) => {
			if (busy) return;
			if (v.phase.kind === "settled" || v.agent.status === "error") { clearTimeout(timer); return done(v); }
			if (v.phase.actor !== "human") return;
			busy = true;
			queueMicrotask(() => {
				try { service.humanAction(v.phase.kind === "betting" ? { kind: "bet", amount: 10 } : { kind: "stand" }, v.revision); }
				finally { busy = false; }
			});
		});
	});
	service.dispose();
	console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(0)}s${view.timeout ? " (超时)" : ""}${view.agent.error ? " 错误: " + view.agent.error : ""}`);
	console.log(`庄家: ${fmt(view.dealer)} = ${view.dealerValue?.total ?? "?"}`);
	for (const [k, h] of view.players.ai.hands.entries()) console.log(`AI 手牌${k + 1}: ${fmt(h.cards)} 注 ${h.wager} ${h.split ? "[分牌]" : ""} → ${h.outcome} ${h.payout}`);
	console.log(`AI 筹码: ${view.players.ai.bankroll}`);
	for (const t of view.traces) {
		const commit = t.tools.filter((x: any) => x.name === "commit_action").at(-1);
		console.log(`  #${t.attempt} rev${t.revision} ${t.playbook} [${t.status}] 请求${t.requests} 工具${t.tools.map((x: any) => x.name + (x.status === "ok" ? "" : "!" + x.status)).join(",")}`);
		console.log(`     提交: ${commit?.summary ?? "-"}`);
		console.log(`     理由: ${t.reason}`);
		if (t.risks.length) console.log(`     风险: ${t.risks.join("; ")}`);
	}
}
process.exit(0);
