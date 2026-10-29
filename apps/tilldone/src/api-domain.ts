/** TillDone Desk L3: provider allowlist, transient credential validation, and secret-free API settings views. */
export const API_PROVIDERS = [
	{ id: "deepseek", name: "DeepSeek", env: "DEEPSEEK_API_KEY", url: "https://platform.deepseek.com/api_keys" },
	{ id: "openai", name: "OpenAI", env: "OPENAI_API_KEY", url: "https://platform.openai.com/api-keys" },
] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number]["id"];
export type CredentialSource = "pi-key" | "pi-oauth" | "pi-command" | "environment" | "missing";
export type ApiError = "invalidKey" | "conflict" | "busy" | "loadFailed" | "saveFailed";
export type CredentialChanges = Readonly<Record<ApiProvider, string | null>>;
export interface ApiSummary { readonly sources: Readonly<Record<ApiProvider, CredentialSource>>; readonly authPath: string; readonly error: ApiError | null }
export interface ApiState {
	readonly open: boolean; readonly saving: boolean; readonly savedRevision: number; readonly saved: boolean;
	readonly summary: ApiSummary; readonly error: ApiError | null;
}
export const INITIAL_API: ApiState = { open: false, saving: false, savedRevision: 0, saved: false, error: null,
	summary: { sources: { deepseek: "missing", openai: "missing" }, authPath: "", error: null } };
export function isApiProvider(value: unknown): value is ApiProvider { return API_PROVIDERS.some((p) => p.id === value); }
export function validApiKey(value: string): boolean {
	// No provider prefix assumptions; prevent command-like credentials and control/whitespace injection.
	return value.length <= 512 && /^[\x21-\x7e]*$/.test(value) && !/[\\]/.test(value) && !value.startsWith("!");
}
export function parseCredentialChanges(raw: unknown): { changes: CredentialChanges } | { error: ApiError } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalidKey" };
	const record = raw as Record<string, unknown>;
	if (Object.keys(record).some((key) => !isApiProvider(key))) return { error: "invalidKey" };
	const changes: Record<ApiProvider, string | null> = { deepseek: null, openai: null };
	for (const provider of API_PROVIDERS) {
		const input = record[provider.id];
		if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "invalidKey" };
		const { key, remove } = input as Record<string, unknown>;
		if (typeof key !== "string" || typeof remove !== "boolean") return { error: "invalidKey" };
		const value = key.trim();
		if (remove && value) return { error: "conflict" };
		if (!validApiKey(value)) return { error: "invalidKey" };
		changes[provider.id] = remove ? "" : value || null;
	}
	return { changes };
}
const zh = {
	entry: "API Key 设置", title: "连接 AI 服务", description: "配置 DeepSeek 或 OpenAI API Key；也可以继续使用现有 Codex 登录。",
	billing: "DeepSeek / OpenAI API 独立按量计费，不等同于 ChatGPT / Codex 订阅。保存不会切换模型，也不会发起付费请求。",
	storage: "与 Pi 共用 auth.json；其中 API Key 为明文存储，请勿分享此文件。旧 Key 不会回填，保存不验证余额、权限或可用性。",
	usage: "本入口管理 Pi 凭证，不切换模型。使用 API 请以 TILLDONE_MODEL=openai/<model-id> 或 deepseek/<model-id> 启动；默认仍为 Codex 订阅模型。Pi 读取时生效，若当前进程仍缓存旧凭证，请重启应用。",
	precedence: "保存会替换对应供应商的 Pi 凭证；openai-codex 登录和其他供应商保持不变。删除仅移除 auth.json 中对应条目，不撤销官方 Key；环境变量或 models.json 仍可能提供凭证。",
	authPath: "Pi 凭证文件",
	currentModel: "当前模型", official: "打开官方密钥管理页 ↗", keyLabel: "API Key", placeholder: "留空保留；输入新 Key 可替换",
	remove: "移除 Pi 已保存的凭证", show: "显示", hide: "隐藏", save: "保存配置", close: "返回", saving: "正在保存…",
	saved: "已保存到 Pi（未验证），没有切换模型或发起请求；如 Pi 仍缓存旧凭证，请重启应用。",
	sourceSaved: "Pi 已保存 Key（未验证）", sourceOAuth: "Pi OAuth 登录（保存将替换）", sourceCommand: "Pi 命令凭证（未执行）", sourceEnvironment: "来自启动环境（未验证）", sourceMissing: "未配置",
	invalidKey: "Key 须为不超过 512 个字符的可打印英文字符，不能包含内部空白、反斜杠或以 ! 开头。",
	conflict: "请在替换 Key 与删除 Key 之间选择一种操作。",
	busy: "Pi 正在更新凭证，请稍后重试；没有覆盖其他进程的更改。",
	loadFailed: "无法读取 Pi 凭证文件，原文件未修改。请检查权限或 JSON 格式。",
	saveFailed: "保存失败，原配置未修改。请检查配置目录权限或磁盘空间。",
};
const en: typeof zh = {
	entry: "API key settings", title: "Connect AI services", description: "Configure a DeepSeek or OpenAI API key, or keep using your existing Codex login.",
	billing: "DeepSeek / OpenAI APIs are billed separately by usage, not covered by a ChatGPT / Codex subscription. Saving never switches models or sends paid requests.",
	storage: "Uses Pi's shared auth.json. API keys there are stored in plaintext; do not share this file. Existing keys are never filled back in. Saving does not verify credit, permissions, or availability.",
	usage: "This manages Pi credentials, not model selection. Launch with TILLDONE_MODEL=openai/<model-id> or deepseek/<model-id> to use an API; the default remains Codex. Pi applies changes when it reads credentials; restart the app if it still uses cached credentials.",
	precedence: "Saving replaces that provider's Pi credential; openai-codex and other providers are preserved. Delete removes only the auth.json entry, not the key at the provider. Environment variables or models.json may still supply credentials.",
	authPath: "Pi credential file",
	currentModel: "Current model", official: "Open official key management ↗", keyLabel: "API key", placeholder: "Leave blank to keep; enter a new key to replace",
	remove: "Remove Pi's saved credential", show: "Show", hide: "Hide", save: "Save settings", close: "Back", saving: "Saving…",
	saved: "Saved to Pi (not verified). No model switch or request was made; restart the app if Pi still uses cached credentials.",
	sourceSaved: "Key saved in Pi (not verified)", sourceOAuth: "Pi OAuth login (save replaces it)", sourceCommand: "Pi command credential (not executed)", sourceEnvironment: "From startup environment (not verified)", sourceMissing: "Not configured",
	invalidKey: "Use at most 512 printable ASCII characters, with no internal whitespace, backslashes, or leading !.",
	conflict: "Choose either replacement or deletion for each key, not both.",
	busy: "Pi is updating credentials. Try again shortly; changes from other processes were not overwritten.",
	loadFailed: "Cannot read Pi's credential file. The original file was not changed. Check permissions or JSON syntax.",
	saveFailed: "Could not save. Existing settings were not changed. Check directory permissions or disk space.",
};
export function apiView(state: ApiState, language: "zh-CN" | "en", model: string) {
	const copy = language === "en" ? en : zh;
	return { open: state.open, saving: state.saving, savedRevision: state.savedRevision, saved: state.saved, model, copy, authPath: state.summary.authPath,
		error: state.error ? copy[state.error] : state.summary.error ? copy[state.summary.error] : "",
		canSave: Boolean(state.summary.authPath) && !state.summary.error && !state.saving,
		providers: API_PROVIDERS.map((provider) => {
			const source = state.summary.sources[provider.id];
			return { id: provider.id, name: provider.name, status: { "pi-key": copy.sourceSaved, "pi-oauth": copy.sourceOAuth, "pi-command": copy.sourceCommand, environment: copy.sourceEnvironment, missing: copy.sourceMissing }[source],
				canRemove: source === "pi-key" || source === "pi-oauth" || source === "pi-command" };
		}),
	};
}
