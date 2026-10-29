/**
 * TillDone Desk L2: a file adapter for Pi's own auth.json, not a second credential store.
 * Uses Pi-compatible proper-lockfile locking and atomic merges; never resolves !commands or OAuth.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { API_PROVIDERS, validApiKey, type ApiError, type ApiProvider, type ApiSummary, type CredentialSource, type CredentialChanges } from "./api-domain.ts";
export function piAuthPath(cwd: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	let directory = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
	if (directory === "~") directory = home;
	else if (directory.startsWith("~/") || directory.startsWith("~\\")) directory = join(home, directory.slice(2));
	return resolve(cwd, directory, "auth.json");
}
export class CredentialError extends Error { constructor(readonly code: ApiError) { super(code); } }
type AuthData = Record<string, unknown>;
export class PiCredentials {
	private readonly redactions = new Set<string>();
	private readonly inherited: Partial<Record<ApiProvider, string>> = {};
	constructor(readonly path: string, env: NodeJS.ProcessEnv = process.env) {
		for (const provider of API_PROVIDERS) {
			const value = env[provider.env];
			if (value) { this.inherited[provider.id] = value; this.redactions.add(value); }
		}
	}
	private read(): AuthData {
		if (!existsSync(this.path)) return {};
		if (lstatSync(this.path).isSymbolicLink() || !lstatSync(this.path).isFile()) throw new CredentialError("loadFailed");
		let data: unknown;
		try { data = JSON.parse(readFileSync(this.path, "utf8").replace(/^\uFEFF/, "")); }
		catch { throw new CredentialError("loadFailed"); }
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new CredentialError("loadFailed");
		// Preserve unknown providers verbatim; inspect only the two supported providers for display.
		for (const provider of API_PROVIDERS) {
			const entry = (data as AuthData)[provider.id];
			if (entry === undefined) continue;
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new CredentialError("loadFailed");
			const credential = entry as Record<string, unknown>;
			if (!["api_key", "oauth"].includes(credential.type as string)) throw new CredentialError("loadFailed");
			if (credential.type === "api_key" && credential.key !== undefined && typeof credential.key !== "string") throw new CredentialError("loadFailed");
			if (typeof credential.key === "string" && !credential.key.startsWith("!")) this.redactions.add(credential.key);
		}
		return data as AuthData;
	}
	summary(): ApiSummary {
		const sources: Record<ApiProvider, CredentialSource> = { deepseek: "missing", openai: "missing" };
		let error: ApiError | null = null;
		try {
			const data = this.read();
			for (const provider of API_PROVIDERS) {
				const credential = data[provider.id] as Record<string, unknown> | undefined;
				sources[provider.id] = credential?.type === "oauth" ? "pi-oauth"
					: typeof credential?.key === "string" && credential.key ? credential.key.startsWith("!") ? "pi-command" : "pi-key"
					: this.inherited[provider.id] ? "environment" : "missing";
			}
		} catch { error = "loadFailed"; }
		return { sources, authPath: this.path, error };
	}
	async save(changes: CredentialChanges): Promise<void> {
		if (Object.keys(changes).some((id) => !API_PROVIDERS.some((p) => p.id === id))) throw new CredentialError("invalidKey");
		for (const provider of API_PROVIDERS) {
			const value = changes[provider.id];
			if (value !== null && (typeof value !== "string" || !validApiKey(value))) throw new CredentialError("invalidKey");
			if (value) this.redactions.add(value);
		}
		if (API_PROVIDERS.every((p) => changes[p.id] === null)) { this.read(); return; }
		let release: (() => Promise<void>) | undefined;
		const temporary = join(dirname(this.path), `.auth-${randomUUID()}.tmp`);
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			if (!existsSync(this.path)) {
				try { writeFileSync(this.path, "{}\n", { flag: "wx", mode: 0o600 }); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			}
			this.read(); // Reject malformed files/symlinks before attempting the shared lock.
			release = await lockfile.lock(this.path, { realpath: false, stale: 30000, retries: { retries: 4, minTimeout: 25, maxTimeout: 150 } });
			const next = this.read(); // Re-read under Pi's lock so concurrent OAuth refreshes are retained.
			for (const provider of API_PROVIDERS) {
				const value = changes[provider.id];
				if (value === null) continue;
				if (value === "") delete next[provider.id];
				else next[provider.id] = { type: "api_key", key: value };
			}
			const serialized = JSON.stringify(next, null, 2) + "\n";
			writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
			if (readFileSync(temporary, "utf8") !== serialized) throw new Error("Write verification failed");
			renameSync(temporary, this.path);
		} catch (error) {
			if (error instanceof CredentialError) throw error;
			throw new CredentialError((error as NodeJS.ErrnoException).code === "ELOCKED" ? "busy" : "saveFailed");
		} finally {
			try { rmSync(temporary, { force: true }); } catch { /* Do not expose credentials or file contents. */ }
			try { await release?.(); } catch { /* The committed file is authoritative even if unlock failed. */ }
		}
	}
	redact(value: string): string {
		for (const key of [...this.redactions].filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(key).join("[REDACTED]");
		return value;
	}
}
