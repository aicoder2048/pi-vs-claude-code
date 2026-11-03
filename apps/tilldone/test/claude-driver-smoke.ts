/** Claude driver smoke: run scripts/claude-driver/desk-run.ts against the real desk window with a fake Pi. No model calls. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const app = resolve(import.meta.dir, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-driver-smoke-")));
const work = join(root, "work");
mkdirSync(work);

function drive(name: string, prompt: string, extra: string[] = []) {
	const promptFile = join(root, `${name}.md`);
	writeFileSync(promptFile, prompt);
	const out = join(root, name);
	const piLog = join(root, `${name}-pi.jsonl`);
	const result = spawnSync("bun", ["scripts/claude-driver/desk-run.ts", "--work", work, "--prompt", promptFile, "--out", out, "--no-pstack", "--poll-sec", "1", "--idle-sec", "2", "--max-min", "3", ...extra], {
		cwd: app,
		encoding: "utf8",
		env: { ...process.env, TILLDONE_PI_BIN: join(app, "test/fake-pi.ts"), FAKE_PI_LOG: piLog, PI_CODING_AGENT_DIR: join(root, `${name}-agent`), OPENAI_API_KEY: "", DEEPSEEK_API_KEY: "" },
	});
	const summaryFile = join(out, "summary.json");
	const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : null;
	const piRecords = existsSync(piLog) ? readFileSync(piLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	return { status: result.status, output: result.stdout + result.stderr, out, summary, piRecords };
}

// 1. A normal run: the fake replays a tilldone session that asks to confirm clearing the list.
const settled = drive("settled", "hello");
assert.equal(settled.status, 0, settled.output);
assert.equal(settled.summary.outcome, "settled");
assert.deepEqual(settled.summary.deniedConfirms, ['Clear TillDone list? — This will remove all 2 task(s) from "probe". Continue?']);
assert.ok(settled.summary.taskChanges >= 1);
assert.deepEqual(
	settled.piRecords.filter((r) => r.type === "extension_ui_response").map((r) => r.confirmed),
	[false],
	"the confirm reached Pi as a denial",
);
assert.equal(settled.piRecords.find((r) => r.type === "prompt")?.message, "hello", "the prompt file is sent as-is");
assert.equal(settled.piRecords.find((r) => r.type === "launch")?.cwd, work, "the desk works in --work");
for (const file of ["run.log", "conversation.txt", "tasks.txt", "final.png"]) assert.ok(existsSync(join(settled.out, file)), `missing ${file}`);
assert.match(readFileSync(join(settled.out, "conversation.txt"), "utf8"), /ok/);
console.log("Driver smoke: settled run OK");

// 2. Pi dies right after the prompt: the desk raises an alert and the driver reports it.
const crashed = drive("crashed", "crash");
assert.equal(crashed.status, 2, crashed.output);
assert.equal(crashed.summary.outcome, "alert");
console.log("Driver smoke: alert run OK");

// 3. anthropic/* is refused before anything launches.
const refused = drive("refused", "hello", ["--model", "anthropic/claude-sonnet-5-5"]);
assert.equal(refused.status, 1);
assert.match(refused.output, /metered API/);
assert.equal(refused.summary, null, "no run directory content");
assert.equal(refused.piRecords.length, 0, "Pi never started");
console.log("Driver smoke: billing refusal OK");
