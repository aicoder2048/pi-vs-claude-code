/**
 * Claude driver: drive the real TillDone Desk (Pi + tilldone, pstack Poteto Mode by default) through one long task,
 * so Claude Code can hand the desk a job and read the result afterwards. Run with --help for the options; see README.md.
 *
 * Every run writes one directory:
 *   summary.json      outcome, timings, dialogs answered, final task list, file names (read this first)
 *   run.log           timestamped progress: connection, task-list changes, dialogs, outcome
 *   conversation.txt  the desk's conversation panel at the end
 *   tasks.txt         the desk's task panel at the end
 *   final.png         screenshot at the end
 *   userdata/         the desk's throwaway Electron profile
 */
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DESK, Desk } from "./lib/desk.ts";
import { checkOptions, deskEnv, type Options, parseOptions, USAGE } from "./lib/options.ts";
import { EXIT_CODE, initialWatch, type Outcome, step, type WatchState } from "./lib/watch.ts";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const FILES = { summary: "summary.json", log: "run.log", conversation: "conversation.txt", tasks: "tasks.txt", screenshot: "final.png", userData: "userdata" } as const;

interface Summary {
	name: string;
	outcome: Outcome["kind"] | "error";
	detail: string;
	exitCode: number;
	startedAt: string;
	endedAt: string;
	durationSeconds: number;
	model: string;
	pstack: boolean;
	work: string;
	prompt: string;
	runDir: string;
	connected: string | null;
	deniedConfirms: string[];
	cancelledAsks: string[];
	taskChanges: number;
	finalTasks: string;
	pageErrors: string[];
	files: typeof FILES;
}

let options: Options | null;
try {
	options = parseOptions(process.argv.slice(2), { cwd: process.cwd(), tmp: tmpdir(), now: new Date() });
	if (!options) {
		console.log(USAGE);
		process.exit(0);
	}
	checkOptions(options, app, process.env);
} catch (error) {
	console.error(`desk-run: ${error instanceof Error ? error.message : error}`);
	process.exit(EXIT_CODE.error);
}
process.exit(await run(options));

async function run(options: Options): Promise<number> {
	const out = options.out;
	await mkdir(out, { recursive: true });
	const path = (file: string) => join(out, file);
	const started = Date.now();
	const log = async (message: string) => {
		const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
		console.log(line);
		await appendFile(path(FILES.log), line + "\n");
	};
	await writeFile(path(FILES.log), "");
	console.log(`run directory: ${out}`);

	let watch: WatchState = initialWatch();
	let outcome: Outcome | { kind: "error"; detail: string } = { kind: "error", detail: "the driver stopped before the run ended" };
	let connected: string | null = null;
	let finalTasks = "";
	const pageErrors: string[] = [];
	let desk: Desk | null = null;
	try {
		const prompt = await readFile(options.prompt, "utf8");
		await log(`app=${app} work=${options.work} prompt=${options.prompt} (${prompt.length} chars) model=${options.model} pstack=${options.pstack}`);
		const build = spawnSync("bun", ["run", "build"], { cwd: app, encoding: "utf8" });
		if (build.status !== 0) throw new Error(`desk build failed:\n${build.stderr || build.stdout}`);
		desk = await Desk.launch(app, path(FILES.userData), deskEnv(options, process.env), (message) => {
			pageErrors.push(message);
			void log(`PAGE ERROR ${message}`);
		});
		connected = await desk.connected();
		await log(`connected: ${connected}`);
		const alertOnSend = await desk.send(prompt);
		if (alertOnSend !== null) {
			outcome = { kind: "alert", detail: alertOnSend };
			await log(`ALERT after send: ${alertOnSend}`);
		} else await log("running");
		const limits = { idleMs: options.idleSeconds * 1000, deadline: started + options.maxMinutes * 60_000 };
		while (alertOnSend === null) {
			await desk.page.waitForTimeout(options.pollSeconds * 1000);
			const result = step(watch, await desk.snapshot(), Date.now(), limits);
			watch = result.state;
			for (const action of result.actions) await (action === "deny-confirm" ? desk.denyConfirm() : desk.cancelAsk());
			for (const line of result.logs) await log(line);
			if (result.outcome) {
				outcome = result.outcome;
				break;
			}
		}
	} catch (error) {
		outcome = { kind: "error", detail: error instanceof Error ? error.message : String(error) };
		await log(`ERROR: ${outcome.detail}`);
	} finally {
		if (desk) {
			// Collect what the desk shows even after an error; each piece is best effort.
			const save = async (label: string, work: () => Promise<unknown>) => {
				try {
					await work();
				} catch (error) {
					await log(`could not save ${label}: ${error instanceof Error ? error.message : error}`);
				}
			};
			await save("screenshot", () => desk!.screenshot(path(FILES.screenshot)));
			await save("conversation", async () => {
				const conversation = await desk!.text(DESK.conversation);
				await writeFile(path(FILES.conversation), conversation);
				await log(`=== final conversation tail ===\n${conversation.slice(-4000)}`);
			});
			await save("tasks", async () => {
				finalTasks = await desk!.text(DESK.tasks);
				await writeFile(path(FILES.tasks), finalTasks);
			});
			await save("diagnostics", async () => log(`=== diagnostics ===\n${(await desk!.text(DESK.diagnostics)).slice(-1500)}`));
			await desk.close().catch(() => undefined);
		}
	}

	const exitCode = EXIT_CODE[outcome.kind];
	const ended = Date.now();
	const summary: Summary = {
		name: options.name,
		outcome: outcome.kind,
		detail: outcome.detail,
		exitCode,
		startedAt: new Date(started).toISOString(),
		endedAt: new Date(ended).toISOString(),
		durationSeconds: Math.round((ended - started) / 1000),
		model: options.model,
		pstack: options.pstack,
		work: options.work,
		prompt: options.prompt,
		runDir: out,
		connected,
		deniedConfirms: watch.deniedConfirms,
		cancelledAsks: watch.cancelledAsks,
		taskChanges: watch.taskChanges,
		finalTasks,
		pageErrors,
		files: FILES,
	};
	await writeFile(path(FILES.summary), JSON.stringify(summary, null, 2) + "\n");
	await log(`outcome: ${outcome.kind} (${outcome.detail}); summary: ${path(FILES.summary)}`);
	return exitCode;
}
