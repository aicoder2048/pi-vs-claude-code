/** TillDone Desk L2: the mutable domain cell; transport facts in, JSON views out, intents to RPC. */
import { initialState, reduce, toViewModel, parseIntent, planIntent, immediateUIResponse, viewChanged, type RecordValue } from "./domain.ts";
import type { Config } from "./config.ts";
import type { Preferences } from "./appearance.ts";
import { PiProcess } from "./rpc.ts";
import { CredentialError, type PiCredentials } from "./credentials.ts";
// Streamed records arrive per token; publishing a full view for each one floods IPC and the renderer.
const PUBLISH_INTERVAL_MS = 33;
export class Desk {
	private state;
	private published: ReturnType<typeof initialState> | null = null;
	private publishTimer: ReturnType<typeof setTimeout> | null = null;
	private pi: PiProcess | null = null;
	private clock: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	private generation = 0;
	private restarting = false;
	constructor(private readonly config: Config, private readonly publish: (view: ReturnType<typeof toViewModel>) => void,
		private readonly options: { preferences?: Preferences; systemDark?: boolean; savePreferences?: (preferences: Preferences) => void;
			credentials?: PiCredentials; openExternal?: (url: string) => Promise<void>; writeClipboard?: (text: string) => void } = {}) {
		this.state = initialState(config.model, config.cwd, options.preferences, options.systemDark);
		if (options.credentials) this.state = reduce(this.state, { type: "desk_api_summary", summary: options.credentials.summary() });
	}
	view() { return toViewModel(this.state); }
	setSystemDark(dark: boolean): void { this.dispatch({ type: "desk_system_theme", dark }); }
	private dispatch(record: RecordValue): void {
		const previous = this.state.preferences;
		this.state = reduce(this.state, record);
		if (this.state.preferences !== previous) {
			try { this.options.savePreferences?.(this.state.preferences); }
			catch (error) { this.state = reduce(this.state, { type: "desk_error", error: `Cannot save preferences: ${String(error)}` }); }
		}
		if (!this.publishTimer && (!this.published || viewChanged(this.published, this.state))) {
			this.publishTimer = setTimeout(() => this.flush(), PUBLISH_INTERVAL_MS);
		}
	}
	/** Publish now if the view changed; intents and shutdown call this so their effects are visible on return. */
	private flush(): void {
		if (this.publishTimer) clearTimeout(this.publishTimer);
		this.publishTimer = null;
		if (this.published && !viewChanged(this.published, this.state)) return;
		this.published = this.state;
		this.publish(this.view());
	}
	private error = (error: unknown) => this.dispatch({ type: "desk_error", error: this.options.credentials?.redact(String(error)) ?? String(error) });
	private sanitize(record: RecordValue): RecordValue {
		if (!this.options.credentials) return record;
		return JSON.parse(JSON.stringify(record, (_key, value) => typeof value === "string" ? this.options.credentials!.redact(value) : value));
	}
	start(): void {
		const generation = ++this.generation;
		this.state = { ...initialState(this.config.model, this.config.cwd, this.state.preferences, this.state.systemDark), api: { ...this.state.api, open: false, saving: false } };
		this.dispatch({ type: "desk_tick", now: Date.now() });
		const pi = this.pi = new PiProcess(this.config, (record) => {
			if (generation !== this.generation) return;
			this.dispatch({ type: "desk_tick", now: Date.now() });
			this.dispatch(this.sanitize(record));
			const response = immediateUIResponse(record);
			if (response) void pi.respond(response).catch(this.error);
			if (["agent_start", "agent_settled", "thinking_level_changed"].includes(record.type)) void this.refresh();
		});
		pi.start();
		void this.refresh();
		let ticks = 0;
		this.clock = setInterval(() => {
			this.dispatch({ type: "desk_tick", now: Date.now() });
			if (++ticks % 8 === 0) void this.refresh();
		}, 250);
	}
	private async refresh(): Promise<void> {
		if (this.polling || !this.pi || this.state.connection === "exited") return;
		this.polling = true;
		try { await this.pi.request({ type: "get_state" }, 10000); }
		catch (error) { this.error(error); }
		finally { this.polling = false; }
	}
	async send(raw: unknown): Promise<void> {
		try { await this.handle(raw); }
		finally { this.flush(); }
	}
	private async handle(raw: unknown): Promise<void> {
		const intent = parseIntent(raw);
		if (!intent) throw new Error("Invalid desktop intent.");
		this.dispatch({ type: "desk_tick", now: Date.now() });
		if (intent.type === "apiOpen" && this.options.credentials) this.dispatch({ type: "desk_api_summary", summary: this.options.credentials.summary() });
		const plan = planIntent(this.state, intent);
		for (const event of plan.events) this.dispatch(event);
		if (plan.externalUrl) {
			try { await this.options.openExternal?.(plan.externalUrl); }
			catch { this.error("Cannot open the link in the browser."); }
		}
		if (plan.clipboard !== undefined) {
			// Rejecting lets the renderer show an error instead of a "copied" mark.
			try {
				if (!this.options.writeClipboard) throw new Error("no clipboard");
				this.options.writeClipboard(plan.clipboard);
			} catch { throw new Error("Cannot copy to the clipboard."); }
		}
		if (plan.saveApi) {
			this.dispatch({ type: "desk_api_saving" });
			try {
				if (!this.options.credentials) throw new CredentialError("loadFailed");
				await this.options.credentials.save(plan.saveApi);
				this.dispatch({ type: "desk_api_saved", summary: this.options.credentials.summary() });
			} catch (error) { this.dispatch({ type: "desk_api_error", error: error instanceof CredentialError ? error.code : "saveFailed" }); }
		}
		if (plan.restart && !this.restarting) {
			this.restarting = true;
			try { await this.stop(); this.start(); } finally { this.restarting = false; }
			return;
		}
		try {
			for (const command of plan.commands) {
				if (command.type === "extension_ui_response") await this.pi?.respond(command);
				else await this.pi?.request(command);
			}
		} catch (error) { this.error(error); throw new Error(this.options.credentials?.redact(String(error)) ?? String(error)); }
	}
	async stop(): Promise<void> {
		if (this.clock) clearInterval(this.clock);
		this.clock = null;
		await this.pi?.stop();
		this.generation++;
		this.flush();
	}
}
