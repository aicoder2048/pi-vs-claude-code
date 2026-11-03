/** Claude driver: the one place that knows the desk's DOM. If the renderer changes an id, fix it here. */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { join } from "node:path";
import type { Snapshot } from "./watch.ts";

export const DESK = {
	prompt: "#prompt",
	send: "#send",
	stop: "#stop",
	alert: "#alert",
	footer: "footer",
	conversation: "#conversation",
	tasks: "#tasks",
	diagnostics: "#stderr",
	confirm: { dialog: "#confirm-dialog", title: "#confirm-title", message: "#confirm-message", deny: "#deny" },
	ask: { dialog: "#ask-dialog", title: "#ask-title", cancel: "#ask-cancel" },
} as const;

const CONNECT_TIMEOUT_MS = 90_000;

export class Desk {
	private constructor(
		private readonly application: ElectronApplication,
		readonly page: Page,
	) {}

	/** Starts the built desk in its own user-data directory, so the run never touches the user's preferences. */
	static async launch(app: string, userData: string, env: NodeJS.ProcessEnv, onPageError: (message: string) => void): Promise<Desk> {
		const application = await electron.launch({
			executablePath: join(app, "node_modules/.bin/electron"),
			args: [app, `--user-data-dir=${userData}`],
			cwd: app,
			env: env as Record<string, string>,
		});
		try {
			const page = await application.firstWindow();
			page.on("pageerror", (error) => onPageError(error.message));
			return new Desk(application, page);
		} catch (error) {
			await application.close();
			throw error;
		}
	}

	/** Waits for Pi to connect (Send enabled) and returns the footer: model, cwd and status. */
	async connected(): Promise<string> {
		await this.page.waitForFunction((send) => !(document.querySelector(send) as HTMLButtonElement).disabled, DESK.send, { timeout: CONNECT_TIMEOUT_MS });
		return (await this.page.locator(DESK.footer).innerText()).replace(/\n/g, " | ");
	}

	/** Pastes the prompt, sends it, and waits for the run to start. Returns the alert text if the desk raises one instead. */
	async send(prompt: string): Promise<string | null> {
		await this.page.locator(DESK.prompt).fill(prompt);
		await this.page.locator(DESK.send).click();
		await this.page.waitForFunction(
			([stop, alert]) => !(document.querySelector(stop) as HTMLButtonElement).disabled || !(document.querySelector(alert) as HTMLElement).hidden,
			[DESK.stop, DESK.alert] as const,
			{ timeout: CONNECT_TIMEOUT_MS },
		);
		return this.alert();
	}

	async snapshot(): Promise<Snapshot> {
		const open = (selector: string) => this.page.locator(selector).evaluate((dialog: HTMLDialogElement) => dialog.open);
		const text = (selector: string) => this.page.locator(selector).innerText();
		const confirm = (await open(DESK.confirm.dialog)) ? `${await text(DESK.confirm.title)} — ${await text(DESK.confirm.message)}` : null;
		const ask = (await open(DESK.ask.dialog)) ? await text(DESK.ask.title) : null;
		return { confirm, ask, alert: await this.alert(), running: !(await this.page.locator(DESK.stop).isDisabled()), tasks: await text(DESK.tasks) };
	}

	denyConfirm = () => this.page.locator(DESK.confirm.deny).click();
	cancelAsk = () => this.page.locator(DESK.ask.cancel).click();

	async alert(): Promise<string | null> {
		const alert = this.page.locator(DESK.alert);
		return (await alert.isVisible()) ? await alert.innerText() : null;
	}

	text = (selector: string) => this.page.locator(selector).innerText();
	screenshot = (path: string) => this.page.screenshot({ path });
	close = () => this.application.close();
}
