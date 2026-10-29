/** TillDone Desk L2: resolve launch configuration and enforce the billing boundary before spawning. */
import { resolve } from "node:path";
export interface Config { piBin: string; model: string; cwd: string; extension: string }
export function loadConfig(appDirectory: string, env: NodeJS.ProcessEnv = process.env, launchCwd = process.cwd()): Config {
	const model = (env.TILLDONE_MODEL ?? "openai-codex/gpt-6.1-sol").trim();
	if (/^anthropic\//i.test(model)) throw new Error(`Refusing model "${model}": anthropic/* uses a metered API without funded credit. Use openai-codex/gpt-6.1-sol instead.`);
	if (!model) throw new Error("TILLDONE_MODEL must not be empty.");
	return { piBin: env.TILLDONE_PI_BIN || "pi", model, cwd: resolve(launchCwd, env.TILLDONE_CWD || "."), extension: resolve(appDirectory, "../../extensions/tilldone") };
}
