/**
 * TillDone Desk L2: child lifecycle, ordered writes, deadlines, and response IDs.
 * All stdout records are delivered to the domain; stderr is diagnostic only.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Config } from "./config.ts";
import { JsonlDecoder } from "./jsonl.ts";
import type { RecordValue } from "./domain.ts";
interface Pending {
	resolve: (record: RecordValue) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}
export class PiProcess {
	private child: ChildProcessWithoutNullStreams | null = null;
	private sequence = 0;
	private pending = new Map<string, Pending>();
	private writes: Promise<void> = Promise.resolve();
	private closed: Promise<void> = Promise.resolve();
	private finished = false;
	constructor(private readonly config: Config, private readonly receive: (record: RecordValue) => void) {}
	start(): void {
		if (this.child) throw new Error("PiProcess can only be started once.");
		const c = this.child = spawn(this.config.piBin, ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--model", this.config.model, "-e", this.config.extension], {
			cwd: this.config.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false,
		});
		const decoder = new JsonlDecoder((record) => {
			this.receive(record);
			if (record.type !== "response" || typeof record.id !== "string") return;
			const pending = this.pending.get(record.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(record.id);
			if (record.success) pending.resolve(record);
			else pending.reject(new Error(record.error || `${record.command} failed`));
		});
		c.stdout.on("data", (chunk: Buffer) => {
			try { decoder.push(chunk); }
			catch (error) { this.receive({ type: "desk_error", error: `Invalid Pi JSONL: ${String(error)}` }); c.kill(); }
		});
		c.stdout.on("end", () => {
			try { decoder.end(); } catch (error) { this.receive({ type: "desk_error", error: String(error) }); }
		});
		c.stderr.setEncoding("utf8");
		c.stderr.on("data", (text: string) => this.receive({ type: "desk_stderr", text }));
		c.stdin.on("error", (error) => this.finish(`Pi stdin failed: ${error.message}`));
		c.on("error", (error) => this.finish(`Cannot start Pi: ${error.message}`));
		this.closed = new Promise((resolve) => c.once("close", (code, signal) => {
			this.finish(`Pi exited (${signal ? `signal ${signal}` : `code ${code}`}). Restart to begin a fresh session.`);
			resolve();
		}));
	}
	private finish(error: string): void {
		if (this.finished) return;
		this.finished = true;
		for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(error)); }
		this.pending.clear();
		this.receive({ type: "desk_exit", error });
	}
	private write(record: RecordValue): Promise<void> {
		const next = this.writes.then(() => new Promise<void>((resolve, reject) => {
			if (!this.child || this.finished || !this.child.stdin.writable) return reject(new Error("Pi is not connected."));
			// A write callback waits until the chunk has flushed, honoring pipe backpressure.
			this.child.stdin.write(`${JSON.stringify(record)}\n`, (error) => error ? reject(error) : resolve());
		}));
		this.writes = next.catch(() => {});
		return next;
	}
	request(command: RecordValue, timeoutMs = 60000): Promise<RecordValue> {
		const id = `desk-${++this.sequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi ${command.type} timed out.`)); }, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			void this.write({ ...command, id }).catch((error) => {
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error);
			});
		});
	}
	respond(response: RecordValue): Promise<void> { return this.write(response); }
	async stop(): Promise<void> {
		const c = this.child;
		if (!c) return;
		c.stdin.end();
		for (const signal of ["SIGTERM", "SIGKILL"] as const) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = await Promise.race([this.closed.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1000); })]);
			clearTimeout(timer);
			if (done) return;
			c.kill(signal);
		}
		await this.closed;
	}
}
