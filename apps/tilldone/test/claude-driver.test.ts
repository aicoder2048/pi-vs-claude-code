/** Claude driver (scripts/claude-driver): option parsing, preflight checks, and the watch policy. No Electron, no model. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkOptions, DEFAULT_MODEL, deskEnv, type Options, parseOptions, stamp } from "../scripts/claude-driver/lib/options.ts";
import { EXIT_CODE, initialWatch, type Snapshot, step } from "../scripts/claude-driver/lib/watch.ts";

const context = { cwd: "/repo", tmp: "/tmp", now: new Date(2026, 10, 3, 9, 5, 7) };
const parse = (...argv: string[]) => parseOptions(argv, context);

describe("claude driver options", () => {
	test("defaults: pstack on, codex model, 150 min, 15 s polls, 20 s idle, run directory under tmp", () => {
		expect(parse("--work", "proj", "--prompt", "p.md")).toEqual({
			work: "/repo/proj",
			prompt: "/repo/p.md",
			out: "/tmp/tilldone-runs/20261103-090507-run",
			name: "run",
			model: DEFAULT_MODEL,
			pstack: true,
			maxMinutes: 150,
			pollSeconds: 15,
			idleSeconds: 20,
		});
	});

	test("every flag", () => {
		const options = parse("--work", "/w", "--prompt", "/p.md", "--out", "runs/a", "--name", "fix-2", "--model", " openai-codex/gpt-6.1-terra ", "--no-pstack", "--max-min", "30", "--poll-sec", "1", "--idle-sec", "2.5");
		expect(options).toMatchObject({ work: "/w", prompt: "/p.md", out: "/repo/runs/a", name: "fix-2", model: "openai-codex/gpt-6.1-terra", pstack: false, maxMinutes: 30, pollSeconds: 1, idleSeconds: 2.5 });
	});

	test("the name goes into the default run directory", () => {
		expect(parse("--work", "w", "--prompt", "p", "--name", "blackjack")?.out).toBe("/tmp/tilldone-runs/20261103-090507-blackjack");
	});

	test("--help wins", () => {
		expect(parse("--work", "w", "--help")).toBeNull();
		expect(parse("-h")).toBeNull();
	});

	test("bad input fails with a message naming the flag", () => {
		expect(() => parse("--prompt", "p")).toThrow("missing --work");
		expect(() => parse("--work", "w")).toThrow("missing --prompt");
		expect(() => parse("--work", "w", "--prompt", "p", "--max-min", "0")).toThrow("--max-min must be a positive number");
		expect(() => parse("--work", "w", "--prompt", "p", "--poll-sec", "soon")).toThrow("--poll-sec must be a positive number");
		expect(() => parse("--work", "w", "--prompt", "p", "--verbose")).toThrow('unknown argument "--verbose"');
		expect(() => parse("--work", "w", "--prompt")).toThrow("--prompt needs a value");
		expect(() => parse("--work", "--prompt", "p")).toThrow("--work needs a value");
		expect(() => parse("--work", "a", "--work", "b", "--prompt", "p")).toThrow("--work given twice");
		expect(() => parse("--work", "w", "--prompt", "p", "--name", "../x")).toThrow("--name may only use");
	});

	test("stamp is local yyyymmdd-hhmmss", () => {
		expect(stamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
	});

	test("desk environment: work dir and model; pstack set or removed", () => {
		const options = parse("--work", "/w", "--prompt", "p")!;
		expect(deskEnv(options, { PATH: "/bin" })).toEqual({ PATH: "/bin", TILLDONE_CWD: "/w", TILLDONE_MODEL: DEFAULT_MODEL, TILLDONE_PSTACK: "1" });
		expect(deskEnv({ ...options, pstack: false }, { TILLDONE_PSTACK: "1" }).TILLDONE_PSTACK).toBeUndefined();
	});
});

describe("claude driver preflight", () => {
	const app = resolve(import.meta.dir, "..");
	const root = mkdtempSync(join(tmpdir(), "claude-driver-"));
	const work = join(root, "work");
	mkdirSync(work);
	const prompt = join(root, "prompt.md");
	writeFileSync(prompt, "/skill:poteto-mode do it");
	const base = (extra: Partial<Options> = {}): Options => ({ ...parse("--work", work, "--prompt", prompt, "--out", join(root, "out"), "--no-pstack")!, ...extra });

	test("a valid run passes", () => {
		expect(() => checkOptions(base(), app, {})).not.toThrow();
	});

	test("anthropic models are refused before launch, by the desk's own rule", () => {
		expect(() => checkOptions(base({ model: "anthropic/claude-sonnet-5-5" }), app, {})).toThrow(/anthropic\/\* uses a metered API/);
		expect(() => checkOptions(base({ model: "Anthropic/claude-opus-5-5" }), app, {})).toThrow(/metered/);
	});

	test("pstack must be installed in the project", () => {
		expect(() => checkOptions(base({ pstack: true }), app, {})).toThrow(/pstack is not installed/);
	});

	test("missing paths, empty prompt, and a used run directory are refused", () => {
		expect(() => checkOptions(base({ work: join(root, "nope") }), app, {})).toThrow("--work is not a directory");
		expect(() => checkOptions(base({ prompt: join(root, "nope.md") }), app, {})).toThrow("--prompt is not a file");
		const empty = join(root, "empty.md");
		writeFileSync(empty, "");
		expect(() => checkOptions(base({ prompt: empty }), app, {})).toThrow("--prompt is empty");
		const used = join(root, "used");
		mkdirSync(used);
		writeFileSync(join(used, "summary.json"), "{}");
		expect(() => checkOptions(base({ out: used }), app, {})).toThrow("--out must be new or empty");
	});
});

describe("claude driver watch policy", () => {
	const quiet: Snapshot = { confirm: null, ask: null, alert: null, running: false, tasks: "" };
	const busy: Snapshot = { ...quiet, running: true };
	const limits = { idleMs: 20_000, deadline: 1_000_000 };

	test("a running desk is not settled and logs nothing new", () => {
		const result = step(initialWatch(), busy, 0, limits);
		expect(result.outcome).toBeUndefined();
		expect(result.actions).toEqual([]);
		expect(result.state.idleSince).toBeNull();
	});

	test("settled only after the idle window, measured from the first idle look", () => {
		let state = initialWatch();
		state = step(state, quiet, 100_000, limits).state;
		expect(state.idleSince).toBe(100_000);
		const early = step(state, quiet, 119_999, limits);
		expect(early.outcome).toBeUndefined();
		const late = step(early.state, quiet, 120_000, limits);
		expect(late.outcome).toEqual({ kind: "settled", detail: "idle for 20 s" });
	});

	test("going busy again resets the idle clock", () => {
		let state = step(initialWatch(), quiet, 0, limits).state;
		state = step(state, busy, 10_000, limits).state;
		expect(state.idleSince).toBeNull();
		state = step(state, quiet, 15_000, limits).state;
		expect(step(state, quiet, 30_000, limits).outcome).toBeUndefined();
	});

	test("confirm dialogs are denied, ask dialogs cancelled, and both recorded", () => {
		const result = step(initialWatch(), { ...quiet, confirm: "Trust project — allow?", ask: "Model for judge" }, 0, limits);
		expect(result.actions).toEqual(["deny-confirm", "cancel-ask"]);
		expect(result.state.deniedConfirms).toEqual(["Trust project — allow?"]);
		expect(result.state.cancelledAsks).toEqual(["Model for judge"]);
		expect(result.logs).toEqual(["CONFIRM DENIED: Trust project — allow?", "ASK CANCELLED: Model for judge"]);
	});

	test("answering a dialog keeps the run from counting as idle", () => {
		let state = step(initialWatch(), quiet, 0, limits).state;
		state = step(state, { ...quiet, confirm: "x" }, 25_000, limits).state;
		expect(state.idleSince).toBeNull();
	});

	test("an alert ends the run", () => {
		expect(step(initialWatch(), { ...busy, alert: "Pi exited" }, 0, limits).outcome).toEqual({ kind: "alert", detail: "Pi exited" });
	});

	test("the deadline ends a busy run", () => {
		expect(step(initialWatch(), busy, 1_000_000, limits).outcome?.kind).toBe("deadline");
	});

	test("task list changes are logged on one line and counted", () => {
		const first = step(initialWatch(), { ...busy, tasks: "Build\n\n1. read\n2. write" }, 0, limits);
		expect(first.logs).toEqual(["tasks: Build | 1. read | 2. write"]);
		expect(first.state.taskChanges).toBe(1);
		const same = step(first.state, { ...busy, tasks: "Build\n1. read\n2. write" }, 1, limits);
		expect(same.logs).toEqual([]);
		expect(same.state.taskChanges).toBe(1);
	});

	test("step does not mutate the state it was given", () => {
		const state = initialWatch();
		step(state, { ...quiet, confirm: "x", tasks: "t" }, 0, limits);
		expect(state).toEqual(initialWatch());
	});

	test("exit codes", () => {
		expect(EXIT_CODE).toEqual({ settled: 0, error: 1, alert: 2, deadline: 3 });
	});
});
