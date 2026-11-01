/** TillDone Desk L2: resolve launch configuration and enforce the billing boundary before spawning. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
export interface Config { piBin: string; model: string; cwd: string; extension: string; pstackExtension?: string }
// Where `pi install npm:pi-pstack -l` puts the pstack extension inside the working project.
const PSTACK_EXTENSION = ".pi/npm/node_modules/pi-pstack/extensions/pstack";
export function loadConfig(appDirectory: string, env: NodeJS.ProcessEnv = process.env, launchCwd = process.cwd()): Config {
	const model = (env.TILLDONE_MODEL ?? "openai-codex/gpt-6.1-sol").trim();
	if (/^anthropic\//i.test(model)) throw new Error(`Refusing model "${model}": anthropic/* uses a metered API without funded credit. Use openai-codex/gpt-6.1-sol instead.`);
	if (!model) throw new Error("TILLDONE_MODEL must not be empty.");
	const cwd = resolve(launchCwd, env.TILLDONE_CWD || ".");
	const config: Config = { piBin: env.TILLDONE_PI_BIN || "pi", model, cwd, extension: resolve(appDirectory, "extensions/tilldone") };
	const pstack = env.TILLDONE_PSTACK ?? "";
	if (pstack === "" || pstack === "0") return config;
	if (pstack !== "1") throw new Error(`TILLDONE_PSTACK must be "1" (enable) or "0"/unset (disable), got "${pstack}".`);
	const pstackExtension = resolve(cwd, PSTACK_EXTENSION);
	if (!existsSync(pstackExtension)) throw new Error(`TILLDONE_PSTACK=1 but pstack is not installed for ${cwd} (missing ${pstackExtension}). Run \`pi install npm:pi-pstack -l\` in that directory.`);
	return { ...config, pstackExtension };
}
/**
 * Pi child arguments. `--no-extensions` stays on so only allowlisted extensions load.
 * With pstack enabled, `-a` trusts the working project's local files, which pstack's skills need.
 * With a session path, Pi resumes that session file instead of starting a new one.
 */
export function piArgs(config: Config, session?: string): string[] {
	const args = ["--mode", "rpc", "--no-extensions", "--model", config.model, "-e", config.extension];
	if (config.pstackExtension) args.push("-e", config.pstackExtension, "-a");
	if (session) args.push("--session", session);
	return args;
}
