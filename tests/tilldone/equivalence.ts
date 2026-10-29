/**
 * Equivalence harness: drives the original extensions/tilldone.ts and the
 * four-layer extensions/tilldone through the real Pi runtime with the faux
 * provider (no network, no real model), records a trace of everything a user
 * or the model can observe, and diffs the two.
 *
 * Pass 1 runs original vs original and requires zero diffs (the harness is
 * deterministic). Pass 2 runs original vs new: every diff must match a
 * catalogued fix (B1, B2, B3), and each fix must be observed where expected.
 *
 * Usage: bun tests/tilldone/equivalence.ts
 * Pi is found from the installed `pi` binary; override with PI_PACKAGE_DIR.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGINAL = join(REPO, "extensions/tilldone.ts");
const NEW = join(REPO, "extensions/tilldone");
const X_TXT = "hello from x.txt\n";

function piPackageDir(): string {
	if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
	const bin = execSync("command -v pi", { shell: "/bin/sh", encoding: "utf8" }).trim();
	for (let dir = dirname(realpathSync(bin)); dir !== dirname(dir); dir = dirname(dir)) {
		const pkg = join(dir, "package.json");
		if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
	}
	throw new Error(`no @earendil-works/pi-coding-agent package above ${bin}; set PI_PACKAGE_DIR`);
}

const PI = piPackageDir();
const sdk = await import(join(PI, "dist/index.js"));
const ai = await import(join(PI, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const PI_VERSION: string = JSON.parse(readFileSync(join(PI, "package.json"), "utf8")).version;

// Trace

type Entry = Record<string, unknown> & { k: string };
const STREAMS = ["def", "ui", "events", "session", "rows", "rowsEnd", "errors", "faux"] as const;
type Stream = (typeof STREAMS)[number];
type Trace = Record<Stream, Entry[]>;
const emptyTrace = (): Trace => Object.fromEntries(STREAMS.map((s) => [s, []])) as unknown as Trace;

const color = (name: string) => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 200, 7) + 16;
// Distinct SGR per color name: truncation still sees zero-width codes, and the trace still tells colors apart.
const theme = {
	fg: (c: string, s: string) => `\x1b[38;5;${color(c)}m${s}\x1b[39m`,
	bg: (c: string, s: string) => `\x1b[48;5;${color(c)}m${s}\x1b[49m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
	italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
	underline: (s: string) => `\x1b[4m${s}\x1b[24m`,
	strikethrough: (s: string) => `\x1b[9m${s}\x1b[29m`,
};

interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	dispose?(): void;
}

const renderAt = (c: Component) => ({ w80: c.render(80), w30: c.render(30) });

/**
 * A plain object, not a Proxy: Pi's runner wraps the UI context with
 * `{ ...ui }`, and spreading a Proxy over an empty target copies no methods.
 * That is why the earlier spike recorded zero UI calls.
 */
function recordingUI(log: Entry[], confirms: boolean[], live: { footer?: Component; widget?: Component }) {
	const tui = { requestRender: () => log.push({ k: "tui.requestRender" }) };
	const footerData = {
		onBranchChange: () => {
			log.push({ k: "footer.subscribe" });
			return () => log.push({ k: "footer.unsubscribe" });
		},
		getGitBranch: () => undefined,
		getExtensionStatuses: () => new Map(),
	};
	const ignored = (k: string) => (...args: unknown[]) => void log.push({ k, args: args.filter((a) => typeof a !== "function") });
	return {
		setStatus: (key: string, text: string | undefined) => void log.push({ k: "setStatus", args: [key, text] }),
		setWidget: (key: string, content: unknown, opts?: unknown) => {
			if (typeof content === "function") {
				live.widget = content(tui, theme);
				log.push({ k: "setWidget", key, opts, render: renderAt(live.widget!) });
			} else {
				live.widget = undefined;
				log.push({ k: "setWidget", key, content, opts });
			}
		},
		setFooter: (factory: unknown) => {
			live.footer?.dispose?.();
			live.footer = typeof factory === "function" ? factory(tui, theme, footerData) : undefined;
			log.push({ k: "setFooter", render: live.footer ? renderAt(live.footer) : null });
		},
		confirm: async (title: string, message: string, opts: unknown) => {
			const answer = confirms.shift() ?? false;
			log.push({ k: "confirm", args: [title, message, opts], answer });
			return answer;
		},
		custom: (factory: (...a: unknown[]) => Component) =>
			new Promise<unknown>((done) => {
				let closed = false;
				const c = factory(tui, theme, {}, (v: unknown) => {
					closed = true;
					done(v);
				});
				log.push({ k: "custom", render: c.render(80), narrow: c.render(30) });
				c.handleInput?.("\x1b");
				log.push({ k: "custom.escape", closed });
				if (!closed) done(undefined);
			}),
		notify: (message: string, type?: string) => void log.push({ k: "notify", args: [message, type] }),
		setTheme: (name: unknown) => {
			log.push({ k: "setTheme", args: [name] });
			return { success: true };
		},
		setTitle: (title: string) => void log.push({ k: "setTitle", args: [title] }),
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
		onTerminalInput: () => () => {},
		setWorkingMessage: ignored("setWorkingMessage"),
		setWorkingVisible: ignored("setWorkingVisible"),
		setWorkingIndicator: ignored("setWorkingIndicator"),
		setHiddenThinkingLabel: ignored("setHiddenThinkingLabel"),
		setHeader: ignored("setHeader"),
		pasteToEditor: ignored("pasteToEditor"),
		setEditorText: ignored("setEditorText"),
		getEditorText: () => "",
		addAutocompleteProvider: ignored("addAutocompleteProvider"),
		setEditorComponent: ignored("setEditorComponent"),
		getEditorComponent: () => undefined,
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		getToolsExpanded: () => false,
		setToolsExpanded: ignored("setToolsExpanded"),
	};
}

// Scenarios

type Call = [name: string, args: Record<string, unknown>];
/** One assistant message: final text, or a batch of tool calls. */
type Reply = string | Call[];
interface Prompt {
	readonly text: string;
	readonly replies: Reply[];
}

interface Run {
	session: any;
	trace: Trace;
	mark(label: string): void;
	prompt(p: Prompt): Promise<void>;
	tilldoneResultEntryIds(): string[];
}

interface Scenario {
	readonly name: string;
	readonly prompts: Prompt[];
	readonly confirms?: boolean[];
	readonly noUI?: boolean;
	readonly argv?: (ext: string) => string;
	readonly after?: (run: Run, ctx: { restart: () => Promise<Run> }) => Promise<void>;
}

const tool = (args: Record<string, unknown>): Call => ["tilldone", args];
const read: Call = ["read", { path: "x.txt" }];

const S2_PROMPTS: Prompt[] = [
	{
		text: "do the work",
		replies: [
			[tool({ action: "new-list", text: "Ship it", description: "release prep" })],
			[tool({ action: "add", texts: ["write notes", "tag release", "announce"] })],
			[tool({ action: "toggle", id: 1 })],
			[read],
			[tool({ action: "toggle", id: 1 })],
			[tool({ action: "toggle", id: 2 })],
			[tool({ action: "update", id: 2, text: "tag v1.0" })],
			[tool({ action: "remove", id: 3 })],
			[tool({ action: "list" })],
			"pausing here",
			[tool({ action: "toggle", id: 2 })],
			"all done",
		],
	},
];

const MATRIX_SETUP: Reply[] = [
	[tool({ action: "new-list", text: "A deliberately long list title that runs past sixty columns!", description: "render matrix" })],
	[tool({ action: "add", texts: ["one", "two", "three", "four", "five", "six with a much longer task text than the footer can show", "seven"] })],
	...[1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6].map((id): Reply => [tool({ action: "toggle", id })]),
	[tool({ action: "list" })],
	"stopping",
	"still stopping",
];

const SCENARIOS: Scenario[] = [
	{ name: "S1 gate-empty", prompts: [{ text: "read x", replies: [[read], "blocked"] }] },
	{ name: "S2 lifecycle", prompts: S2_PROMPTS },
	{
		name: "S3 B3-batch",
		prompts: [{ text: "batch", replies: [[tool({ action: "add", text: "a" })], [tool({ action: "toggle", id: 1 }), read], "batched", "nudged"] }],
	},
	{
		name: "S4 confirm",
		confirms: [false, true, false, true, true],
		prompts: [
			{
				text: "lists",
				replies: [
					[tool({ action: "add", text: "a" })],
					[tool({ action: "new-list", text: "X" })],
					[tool({ action: "new-list", text: "X" })],
					[tool({ action: "add", text: "b" })],
					[tool({ action: "clear" })],
					[tool({ action: "clear" })],
					[tool({ action: "new-list", text: "Z" })],
					[tool({ action: "new-list", text: "Y", description: "why" })],
					"done",
				],
			},
		],
	},
	{
		name: "S5 no-UI",
		noUI: true,
		prompts: [
			{
				text: "no ui",
				replies: [[tool({ action: "add", text: "a" })], [tool({ action: "clear" })], [tool({ action: "new-list", text: "X" })], "done", "nudged"],
			},
			{ text: "/tilldone", replies: [] },
		],
		after: async (run) => {
			const cmd = run.session.extensionRunner.getCommand("tilldone");
			const notes: Entry[] = [];
			await cmd.handler("", { hasUI: false, ui: { notify: (...args: unknown[]) => notes.push({ k: "notify", args }) } });
			run.trace.ui.push(...notes);
		},
	},
	{
		name: "S6 errors",
		prompts: [
			{
				text: "errors",
				replies: [
					[tool({ action: "add", text: "a" })],
					[tool({ action: "new-list" })],
					[tool({ action: "add" })],
					[tool({ action: "add", texts: [] })],
					[tool({ action: "toggle" })],
					[tool({ action: "toggle", id: 9 })],
					[tool({ action: "remove" })],
					[tool({ action: "remove", id: 9 })],
					[tool({ action: "update", text: "x" })],
					[tool({ action: "update", id: 1, text: "" })],
					[tool({ action: "update", id: 9, text: "x" })],
					"errors done",
					"nudged",
				],
			},
		],
	},
	{
		name: "S7 nudge-cycle",
		prompts: [
			{ text: "first", replies: [[tool({ action: "add", text: "a" })], "stop", "stop again"] },
			{ text: "second", replies: ["stop", "stop again"] },
		],
	},
	{
		name: "S8 tree-restore",
		prompts: S2_PROMPTS,
		after: async (run) => {
			const target = run.tilldoneResultEntryIds()[2];
			run.mark("navigate");
			await run.session.navigateTree(target);
		},
	},
	{
		name: "S9 resume",
		prompts: S2_PROMPTS,
		after: async (_run, { restart }) => {
			await restart();
		},
	},
	{ name: "S10 launch-identity", argv: (ext) => ext, prompts: [{ text: "hi", replies: [[read], "blocked"] }] },
	{ name: "S11 render-matrix", prompts: [{ text: "matrix", replies: MATRIX_SETUP }] },
	{ name: "S12 overlay", prompts: [{ text: "matrix", replies: MATRIX_SETUP }, { text: "/tilldone", replies: [] }] },
];

// Runner

/** Files Pi actually loaded, per run: proves the new directory resolves to its index.ts, not the sibling tilldone.ts. */
let loadedFiles: string[] = [];

const toFaux = (r: Reply) =>
	typeof r === "string" ? ai.fauxAssistantMessage(r) : ai.fauxAssistantMessage(r.map(([name, args]) => ai.fauxToolCall(name, args)), { stopReason: "toolUse" });

const texts = (content: unknown) =>
	Array.isArray(content) ? content.map((c: any) => (c.type === "text" ? c.text : `<${c.type}>`)) : content;

async function runScenario(ext: string, sc: Scenario): Promise<Trace> {
	loadedFiles = [];
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tilldone-eq-")));
	const agentDir = join(cwd, ".agentdir");
	const sessionDir = join(cwd, "sessions");
	mkdirSync(agentDir);
	writeFileSync(join(cwd, "x.txt"), X_TXT);
	const trace = emptyTrace();
	const confirms = [...(sc.confirms ?? [])];
	const savedArgv = process.argv;
	if (sc.argv) process.argv = [savedArgv[0], savedArgv[1], "-e", sc.argv(ext)];

	const faux = ai.createFauxCore({});
	const model = faux.getModel();
	const fauxExt = (pi: any) =>
		pi.registerProvider(model.provider, {
			baseUrl: "http://faux.invalid",
			apiKey: "faux",
			api: faux.api,
			streamSimple: faux.streamSimple,
			models: faux.models.map((m: any) => ({ id: m.id, name: m.name, reasoning: m.reasoning, input: m.input, cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
		});

	let tilldoneEvents = 0;
	const eventResults: { input: unknown; content: unknown; details: unknown }[] = [];
	const observerExt = (pi: any) =>
		pi.on("tool_result", (e: any) => {
			const isTilldone = e.toolName === "tilldone";
			const n = isTilldone ? ++tilldoneEvents : undefined;
			trace.events.push({ k: "tool_result", toolName: e.toolName, n, input: e.input, content: texts(e.content), isError: e.isError, details: JSON.stringify(e.details) });
			if (isTilldone) {
				eventResults.push(structuredClone({ input: e.input, content: e.content, details: e.details }));
				trace.ui.push({ k: "mark", label: `tool_result tilldone #${n}` });
			}
		});

	const live: { footer?: Component; widget?: Component } = {};
	const ui = recordingUI(trace.ui, confirms, live);

	const open = async (sessionManager: any): Promise<Run> => {
		const loader = new sdk.DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			additionalExtensionPaths: [ext],
			extensionFactories: [fauxExt, observerExt],
		});
		await loader.reload();
		loadedFiles.push(...loader.getExtensions().extensions.map((e: any) => e.resolvedPath).filter((f: string) => !f.startsWith("<")));
		const { session } = await sdk.createAgentSession({ cwd, agentDir, model, sessionManager, resourceLoader: loader });
		const onError = (e: any) => trace.errors.push({ k: "error", event: e.event, error: e.error });
		await session.bindExtensions(sc.noUI ? { mode: "print", onError } : { uiContext: ui, mode: "interactive", onError });
		if (sc.argv) await new Promise((r) => setTimeout(r, 250));

		const mark = (label: string) => void trace.ui.push({ k: "mark", label });
		const rerender = () => {
			mark("rerender");
			if (live.footer) trace.ui.push({ k: "rerender.footer", render: renderAt(live.footer) });
			if (live.widget) trace.ui.push({ k: "rerender.widget", render: renderAt(live.widget) });
		};
		return {
			session,
			trace,
			mark,
			async prompt(p) {
				faux.setResponses(p.replies.map(toFaux));
				mark(`prompt ${JSON.stringify(p.text)}`);
				await session.prompt(p.text);
				await session.waitForIdle();
				rerender();
				trace.faux.push({ k: "pending", prompt: p.text, count: faux.getPendingResponseCount() });
			},
			tilldoneResultEntryIds: () =>
				session.sessionManager
					.getEntries()
					.filter((e: any) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "tilldone")
					.map((e: any) => e.id),
		};
	};

	try {
		let run = await open(sdk.SessionManager.create(cwd, sessionDir));
		const def = run.session.getToolDefinition("tilldone");
		trace.def.push(
			{ k: "tool", name: def.name, label: def.label, description: def.description, parameters: JSON.stringify(def.parameters) },
			{ k: "executionMode", value: def.executionMode },
			{ k: "command", description: run.session.extensionRunner.getCommand("tilldone")?.description },
		);
		for (const p of sc.prompts) await run.prompt(p);
		if (sc.after) {
			await sc.after(run, {
				restart: async () => {
					const file = run.session.sessionManager.getSessionFile();
					run.session.dispose();
					run.mark("resume");
					run = await open(sdk.SessionManager.open(file, sessionDir));
					return run;
				},
			});
			run.mark("after");
			if (live.footer) trace.ui.push({ k: "rerender.footer", render: renderAt(live.footer) });
			if (live.widget) trace.ui.push({ k: "rerender.widget", render: renderAt(live.widget) });
		}

		const toolDef = run.session.getToolDefinition("tilldone");
		let n = 0;
		for (const m of run.session.messages as any[]) {
			if (m.role === "toolResult") {
				const ord = m.toolName === "tilldone" ? ++n : undefined;
				trace.session.push({ k: "toolResult", toolName: m.toolName, n: ord, content: texts(m.content), isError: m.isError, details: JSON.stringify(m.details) });
				if (ord) {
					const r = (expanded: boolean) => toolDef.renderResult(m, { expanded, isPartial: false }, theme, {}).render(80);
					trace.rowsEnd.push({ k: "rowEnd", n: ord, collapsed: r(false), expanded: r(true) });
				}
			} else if (m.role === "assistant") {
				trace.session.push({
					k: "assistant",
					stopReason: m.stopReason,
					error: m.errorMessage,
					content: m.content.map((c: any) => (c.type === "toolCall" ? { call: c.name, args: c.arguments } : { [c.type]: c.text ?? c.thinking })),
				});
			} else if (m.role === "custom") {
				trace.session.push({ k: "custom", customType: m.customType, content: m.content, display: m.display });
			} else {
				trace.session.push({ k: m.role, content: texts(m.content) });
			}
		}
		eventResults.forEach((res, i) => {
			const r = (expanded: boolean) => toolDef.renderResult(res, { expanded, isPartial: false }, theme, {}).render(80);
			trace.rows.push({ k: "row", n: i + 1, call: toolDef.renderCall(res.input, theme, {}).render(80), collapsed: r(false), expanded: r(true) });
		});
		run.session.dispose();
	} finally {
		process.argv = savedArgv;
		rmSync(cwd, { recursive: true, force: true });
	}
	return JSON.parse(JSON.stringify(trace).replaceAll(cwd, "<cwd>"));
}

// Diff and the expected-diff catalog

interface Diff {
	readonly stream: Stream;
	/** null when the streams differ in length and are compared whole. */
	readonly index: number | null;
	readonly a: any;
	readonly b: any;
}

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

function diffTraces(a: Trace, b: Trace): Diff[] {
	const diffs: Diff[] = [];
	for (const stream of STREAMS) {
		const [A, B] = [a[stream], b[stream]];
		if (A.length !== B.length) diffs.push({ stream, index: null, a: A, b: B });
		else A.forEach((x, i) => !same(x, B[i]) && diffs.push({ stream, index: i, a: x, b: B[i] }));
	}
	return diffs;
}

const NONE_ACTIVE = "🚫 No task is in progress. You MUST use `tilldone toggle` to mark a task as inprogress before doing any work.";

/** The original calls setStatus(text, "tilldone"); undo the swap so B2 does not mask other diffs. */
const unswapStatus = (e: Entry): Entry => (e.k === "setStatus" && (e.args as unknown[])[1] === "tilldone" ? { ...e, args: ["tilldone", (e.args as unknown[])[0]] } : e);

const segmentAfter = (ui: Entry[], start: number) => {
	const end = ui.findIndex((e, i) => i > start && e.k === "mark");
	return ui.slice(start + 1, end === -1 ? ui.length : end);
};

interface Matcher {
	readonly id: string;
	readonly mustFireIn: readonly string[];
	matches(d: Diff, a: Trace, b: Trace, scenario: string): boolean;
}

const CATALOG: Matcher[] = [
	{
		id: "B2",
		mustFireIn: ["S2 lifecycle"],
		matches: (d) =>
			d.stream === "ui" && d.index !== null && d.a.k === "setStatus" && d.b.k === "setStatus" && d.a.args[1] === "tilldone" && same(unswapStatus(d.a), d.b),
	},
	{
		id: "B3-def",
		mustFireIn: SCENARIOS.map((s) => s.name),
		matches: (d) => d.stream === "def" && d.a.k === "executionMode" && d.a.value === undefined && d.b.value === "sequential",
	},
	{
		id: "B3-batch",
		mustFireIn: ["S3 B3-batch"],
		matches: (d, _a, _b, sc) => {
			if (sc !== "S3 B3-batch") return false;
			const blocked = (e: any) => e.toolName === "read" && e.isError === true && same(e.content, [NONE_ACTIVE]);
			const ran = (e: any) => e.toolName === "read" && e.isError === false && String(e.content).includes(X_TXT.trim());
			if (d.stream === "session" && d.index !== null) return blocked(d.a) && ran(d.b);
			if (d.stream === "events" && d.index === null) {
				// Parallel mode settles a gate-blocked call without a tool_result event; sequential mode runs it.
				const notRead = (e: any) => e.toolName !== "read";
				return d.a.every((e: any) => notRead(e) || blocked(e)) && d.b.some(ran) && d.b.every((e: any) => notRead(e) || ran(e)) && same(d.a.filter(notRead), d.b.filter(notRead));
			}
			return false;
		},
	},
	{
		id: "B1-history",
		mustFireIn: ["S2 lifecycle"],
		matches: (d, a, b) => {
			if (d.index === null || d.a.n === undefined || d.a.n !== d.b.n) return false;
			const n = d.a.n;
			if (d.stream === "session" && d.a.toolName === "tilldone") {
				const [evA, evB] = [a.events.find((e) => e.n === n), b.events.find((e) => e.n === n)];
				return !!evA && same(evA, evB) && d.b.details === evB!.details && d.a.details !== evA.details && same({ ...d.a, details: 0 }, { ...d.b, details: 0 });
			}
			if (d.stream === "rowsEnd") {
				const [rowA, rowB] = [a.rows[n - 1], b.rows[n - 1]];
				return same(rowA, rowB) && same([d.b.collapsed, d.b.expanded], [rowB.collapsed, rowB.expanded]);
			}
			return false;
		},
	},
	{
		id: "B1-restore",
		mustFireIn: ["S8 tree-restore"],
		// The new tail after `navigate` shows a widget the original lacks, so the ui streams differ in length
		// and arrive as one whole-stream diff. Everything before `navigate` must match modulo B2.
		matches: (d, _a, _b, sc) => {
			if (sc !== "S8 tree-restore" || d.stream !== "ui" || d.index !== null) return false;
			const [A, B] = [d.a as Entry[], d.b as Entry[]];
			const nav = A.findIndex((e) => e.k === "mark" && e.label === "navigate");
			if (nav === -1 || !same(A.slice(0, nav + 1).map(unswapStatus), B.slice(0, nav + 1).map(unswapStatus))) return false;
			const target = A.findIndex((e) => e.k === "mark" && e.label === "tool_result tilldone #3");
			const paintedAtTarget = A.slice(A.findLastIndex((e, i) => i < target && e.k === "mark") + 1, target);
			const [postNavA, postNavB] = [segmentAfter(A, nav), segmentAfter(B, nav)];
			// The new restore must paint exactly what the original painted right after the target call ran,
			// and the original must not (its stored snapshot was rewritten by later toggles).
			if (!same(postNavB.map(unswapStatus), paintedAtTarget.map(unswapStatus)) || same(postNavA, postNavB.map(unswapStatus))) return false;
			const tail = B.slice(nav + 1 + postNavB.length);
			const painted = (k: string) => (postNavB.find((e) => e.k === k) as any)?.render;
			return (
				tail.length > 0 &&
				tail.every((e) => (e.k === "mark" && e.label === "after") || (e.k === "rerender.footer" && same(e.render, painted("setFooter"))) || (e.k === "rerender.widget" && same(e.render, painted("setWidget"))))
			);
		},
	},
];

// Main

const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
	if (!ok) failures.push(msg);
	console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

function sanity(label: string, t: Trace) {
	check(t.errors.length === 0, `${label}: no extension errors ${t.errors.length ? JSON.stringify(t.errors) : ""}`);
	check(
		t.faux.every((f) => f.count === 0),
		`${label}: faux script fully consumed`,
	);
}

console.log(`Pi ${PI_VERSION} at ${PI}`);
console.log(`\nPass 1: original vs original (harness determinism)`);
for (const sc of SCENARIOS) {
	const [a, b] = [await runScenario(ORIGINAL, sc), await runScenario(ORIGINAL, sc)];
	const diffs = diffTraces(a, b);
	check(diffs.length === 0, `${sc.name}: 0 diffs${diffs.length ? ` (got ${diffs.length}: ${JSON.stringify(diffs[0]).slice(0, 400)})` : ""}`);
	check(a.ui.length > 0 || !!sc.noUI, `${sc.name}: UI trace is non-empty (${a.ui.length} entries)`);
	sanity(`${sc.name} original`, a);
}

console.log(`\nPass 2: original vs four-layer`);
const fired = new Map<string, Set<string>>();
for (const sc of SCENARIOS) {
	const a = await runScenario(ORIGINAL, sc);
	const b = await runScenario(NEW, sc);
	check(loadedFiles.length > 0 && loadedFiles.every((f) => f === join(NEW, "index.ts")), `${sc.name}: Pi loaded ${[...new Set(loadedFiles)].map((f) => f.replace(REPO + "/", "")).join()}`);
	sanity(`${sc.name} new`, b);
	if (process.env.EQ_DUMP_DIR) {
		const file = (side: string) => join(process.env.EQ_DUMP_DIR!, `${sc.name.split(" ")[0]}-${side}.json`);
		writeFileSync(file("original"), JSON.stringify(a, null, 1));
		writeFileSync(file("new"), JSON.stringify(b, null, 1));
	}
	const diffs = diffTraces(a, b);
	const counts = new Map<string, number>();
	const unexplained: Diff[] = [];
	for (const d of diffs) {
		const m = CATALOG.find((m) => m.matches(d, a, b, sc.name));
		if (!m) unexplained.push(d);
		else {
			counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
			if (!fired.has(m.id)) fired.set(m.id, new Set());
			fired.get(m.id)!.add(sc.name);
		}
	}
	const summary = [...counts].map(([id, c]) => `${id}x${c}`).join(", ") || "none";
	check(unexplained.length === 0, `${sc.name}: ${diffs.length} diffs, ${unexplained.length} unexplained (catalogued: ${summary})`);
	for (const d of unexplained.slice(0, 3)) console.log(`       unexplained ${d.stream}[${d.index}]\n         a=${JSON.stringify(d.a).slice(0, 600)}\n         b=${JSON.stringify(d.b).slice(0, 600)}`);
	if (sc.name === "S10 launch-identity") {
		const ids = (t: Trace) => t.ui.filter((e) => e.k === "setTheme" || e.k === "setTitle").map((e) => `${e.k}(${(e.args as string[]).join()})`);
		check(same(ids(b), ["setTheme(everforest)", "setTitle(π - tilldone)"]) && same(ids(a), ids(b)), `${sc.name}: theme and title ${ids(b).join(" ")}`);
	}
}
for (const m of CATALOG) for (const sc of m.mustFireIn) check(!!fired.get(m.id)?.has(sc), `${m.id} fix observed in ${sc}`);

console.log(`\nReport: launching the new extension by its file path`);
{
	const variant: Scenario = { name: "S10 file-path variant", argv: (ext) => join(ext, "index.ts"), prompts: [{ text: "hi", replies: [[read], "blocked"] }] };
	const t = await runScenario(NEW, variant);
	console.log(`  -e extensions/tilldone/index.ts gives: ${t.ui.filter((e) => e.k === "setTheme" || e.k === "setTitle").map((e) => `${e.k}(${(e.args as string[]).join()})`).join(" ") || "no theme or title call"}`);
}

console.log(`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`);
process.exit(failures.length === 0 ? 0 : 1);
