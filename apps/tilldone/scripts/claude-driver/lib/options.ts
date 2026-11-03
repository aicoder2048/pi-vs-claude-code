/** Claude driver: command-line options. Parsing is pure; checkOptions touches the file system and the desk's own config rules. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../../../src/config.ts";

export interface Options {
	work: string;
	prompt: string;
	out: string;
	name: string;
	model: string;
	pstack: boolean;
	maxMinutes: number;
	pollSeconds: number;
	idleSeconds: number;
}

export const DEFAULT_MODEL = "openai-codex/gpt-6.1-sol";

export const USAGE = `Drive the real TillDone Desk through one long task, unattended.

Usage (from apps/tilldone):
  bun scripts/claude-driver/desk-run.ts --work <project dir> --prompt <prompt.md> [options]

Required:
  --work <dir>       Project the desk works in (TILLDONE_CWD). With pstack it must have \`pi install npm:pi-pstack -l\`.
  --prompt <file>    Prompt pasted into the desk as-is. Start it with /skill:poteto-mode for Poteto Mode.

Options:
  --out <dir>        Run directory, must be new or empty (default: <tmp>/tilldone-runs/<stamp>-<name>)
  --name <name>      Run name used in the default run directory (default: run)
  --model <id>       Session model (default: ${DEFAULT_MODEL}); anthropic/* is refused
  --no-pstack        Start the desk without pstack (TILLDONE_PSTACK unset)
  --max-min <n>      Hard time limit in minutes (default: 150)
  --poll-sec <n>     Seconds between checks of the desk (default: 15)
  --idle-sec <n>     Seconds the desk must stay idle to count as settled (default: 20)
  --help             Show this text

Exit codes: 0 settled, 1 driver error, 2 desk alert, 3 time limit reached.`;

const VALUE_FLAGS = ["work", "prompt", "out", "name", "model", "max-min", "poll-sec", "idle-sec"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

/** Local time as yyyymmdd-hhmmss, for default run directory names. */
export const stamp = (date: Date): string => {
	const two = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
};

const positive = (flag: string, raw: string): number => {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`--${flag} must be a positive number, got "${raw}"`);
	return value;
};

/** Returns null for --help. Throws with a message naming the bad flag otherwise. */
export function parseOptions(argv: readonly string[], context: { cwd: string; tmp: string; now: Date }): Options | null {
	const values: Partial<Record<ValueFlag, string>> = {};
	let pstack = true;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--help" || token === "-h") return null;
		if (token === "--no-pstack") {
			pstack = false;
			continue;
		}
		const flag = token.startsWith("--") ? (token.slice(2) as ValueFlag) : undefined;
		if (!flag || !VALUE_FLAGS.includes(flag)) throw new Error(`unknown argument "${token}" (see --help)`);
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`--${flag} needs a value`);
		if (values[flag] !== undefined) throw new Error(`--${flag} given twice`);
		values[flag] = value;
		i++;
	}
	if (!values.work) throw new Error("missing --work (see --help)");
	if (!values.prompt) throw new Error("missing --prompt (see --help)");
	const name = values.name ?? "run";
	if (!/^[\w.-]+$/.test(name)) throw new Error(`--name may only use letters, digits, ".", "_" and "-", got "${name}"`);
	return {
		work: resolve(context.cwd, values.work),
		prompt: resolve(context.cwd, values.prompt),
		out: values.out ? resolve(context.cwd, values.out) : join(context.tmp, "tilldone-runs", `${stamp(context.now)}-${name}`),
		name,
		model: (values.model ?? DEFAULT_MODEL).trim(),
		pstack,
		maxMinutes: positive("max-min", values["max-min"] ?? "150"),
		pollSeconds: positive("poll-sec", values["poll-sec"] ?? "15"),
		idleSeconds: positive("idle-sec", values["idle-sec"] ?? "20"),
	};
}

/** Environment for the desk process: the driver's own environment plus the desk's launch variables. */
export function deskEnv(options: Options, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base, TILLDONE_CWD: options.work, TILLDONE_MODEL: options.model };
	if (options.pstack) env.TILLDONE_PSTACK = "1";
	else delete env.TILLDONE_PSTACK;
	return env;
}

/**
 * Fails before anything launches: the paths must exist, the run directory must not hold an earlier run,
 * and the desk's own loadConfig must accept the model (no anthropic/*) and find pstack in the project.
 */
export function checkOptions(options: Options, app: string, base: NodeJS.ProcessEnv): void {
	if (!existsSync(options.work) || !statSync(options.work).isDirectory()) throw new Error(`--work is not a directory: ${options.work}`);
	if (!existsSync(options.prompt) || !statSync(options.prompt).isFile()) throw new Error(`--prompt is not a file: ${options.prompt}`);
	if (statSync(options.prompt).size === 0) throw new Error(`--prompt is empty: ${options.prompt}`);
	if (existsSync(options.out) && readdirSync(options.out).length > 0) throw new Error(`--out must be new or empty, and ${options.out} is not`);
	if (!existsSync(join(app, "node_modules/.bin/electron"))) throw new Error(`Electron is not installed in ${app}; run \`bun install\` there first`);
	loadConfig(app, deskEnv(options, base), app);
}
