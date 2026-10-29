// Probe pi RPC protocol with the four-layer tilldone extension.
// Usage: bun specs/tilldone-electron/rpc-probe.ts "$PWD" <out.jsonl>
// Produced rpc-probe.jsonl (pi 1.4.0, openai-codex/gpt-6.1-sol; local paths replaced with <repo>).
import { appendFileSync, writeFileSync } from "node:fs";

const [repo, out] = process.argv.slice(2);
writeFileSync(out, "");
const log = (dir: string, rec: unknown) => appendFileSync(out, JSON.stringify({ dir, t: Date.now(), rec }) + "\n");

const proc = Bun.spawn(
	["pi", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
	 "--model", "openai-codex/gpt-6.1-sol", "--thinking", "low", "-e", "extensions/tilldone"],
	{ cwd: repo, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);

const send = (rec: object) => { log("in", rec); proc.stdin.write(JSON.stringify(rec) + "\n"); proc.stdin.flush(); };

let settled: () => void;
const settledP = new Promise<void>((r) => (settled = r));

(async () => {
	const dec = new TextDecoder();
	let buf = "";
	for await (const chunk of proc.stdout) {
		buf += dec.decode(chunk, { stream: true });
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			if (!line) continue;
			let rec: any;
			try { rec = JSON.parse(line); } catch { log("out-raw", line); continue; }
			log("out", rec);
			if (rec.type === "extension_ui_request" && rec.method === "confirm") {
				send({ type: "extension_ui_response", id: rec.id, confirmed: true });
			}
			if (rec.type === "agent_settled") settled();
		}
	}
})();
(async () => { for await (const c of proc.stderr) log("stderr", new TextDecoder().decode(c)); })();

send({ id: "s1", type: "get_state" });
send({ id: "c1", type: "get_commands" });
send({
	id: "p1",
	type: "prompt",
	message:
		"Use the tilldone tool only. 1) Create a list titled 'probe' with two tasks: 'alpha' and 'beta'. " +
		"2) Mark both done. 3) Clear the list. Do nothing else and reply 'ok' at the end.",
});

let timer: ReturnType<typeof setTimeout> | undefined;
const timeout = new Promise<void>((r) => (timer = setTimeout(() => { log("probe", "timeout"); r(); }, 240_000)));
await Promise.race([settledP, timeout]);
clearTimeout(timer);
send({ id: "s2", type: "get_state" });
await Bun.sleep(1500);
proc.kill();
await proc.exited;
