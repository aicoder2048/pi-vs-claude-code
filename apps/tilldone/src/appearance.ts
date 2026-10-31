/** TillDone Desk L3: pure appearance preferences and localized UI copy; no platform dependencies. */
export const THEME_IDS = ["system", "light", "dark", "paper", "night", "ink", "neon"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export interface Preferences { readonly theme: ThemeId; readonly language: "zh-CN" | "en" }
// Names and palette identities follow mini-six-ren; selection/persistence stays in Desk's domain.
const FEATURED_THEMES = [
	{ id: "paper", zh: "素纸", en: "Paper", icon: "▤" },
	{ id: "night", zh: "星夜", en: "Night", icon: "✦" },
	{ id: "ink", zh: "水墨", en: "Ink", icon: "◒" },
	{ id: "neon", zh: "霓虹", en: "Neon", icon: "ϟ" },
] as const;
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({ theme: "system", language: "zh-CN" });
export function parsePreferences(raw: unknown): Preferences | undefined {
	if (!raw || typeof raw !== "object") return;
	const r = raw as Record<string, unknown>;
	if (!THEME_IDS.includes(r.theme as ThemeId) || !["zh-CN", "en"].includes(r.language as string)) return;
	return { theme: r.theme as Preferences["theme"], language: r.language as Preferences["language"] };
}
const zh = {
	productName: "边牧任务桌面", slogan: "交给边牧(AI牧羊犬)，安心放牧(任务必达)", logo: "AI 边牧标志",
	workspace: "PI · 任务工作台", settings: "设置", theme: "主题", themeShortcuts: "快捷切换主题", system: "系统", light: "浅色", dark: "深色", language: "语言",
	chat: "对话", taskPanel: "TillDone 任务面板", taskList: "任务列表", empty: "让 Pi 制定计划，并逐项完成任务。",
	message: "发送消息给 Pi", keyboard: "Enter 发送 · Shift+Enter 换行", placeholder: "你想完成什么任务？",
	delivery: "运行中的消息发送方式", steer: "立即引导", followUp: "后续跟进", stop: "停止", send: "发送",
	connecting: "正在连接 Pi…", ready: "可以发送新任务", busy: "运行中 · 可选择消息发送方式", restartHint: "重启 Pi 后继续",
	disconnected: "Pi 已断开连接", reportedError: "Pi 报告了错误", restart: "重启 Pi", diagnostics: "Pi 诊断信息",
	thinking: "思考深度", running: "● 运行中", idle: "○ 空闲", noActive: "暂无进行中的任务", done: "已完成", working: "当前任务",
	assistant: "助手", user: "你", nudge: "TillDone 继续提醒", notice: "通知", args: "参数", result: "结果",
	toolRunning: "执行中", toolDone: "已完成", toolError: "出错", taskIdle: "未开始", taskInprogress: "进行中", taskDone: "已完成",
	deny: "拒绝", allow: "允许", closesIn: "自动关闭倒计时", seconds: "秒",
	split: "细分", splitTitle: "让边牧把这个任务拆成更小的子任务", splitRequest: "请把任务 #{id}「{text}」细分成更小的子任务：用 tilldone split（id={id}）原位替换，然后继续。",
	newSession: "新会话", newSessionTitle: "开始新会话？", newSessionMessage: "将重启 Pi：当前对话和任务清单都会清空，模型不再记得之前的内容。", cancel: "取消", newSessionConfirm: "开始新会话",
};
export type Copy = typeof zh;
const en: Copy = {
	productName: "TillDone Desk", slogan: "Don't stop until it's done", logo: "AI border collie logo",
	workspace: "PI · TASK WORKSPACE", settings: "Settings", theme: "Theme", themeShortcuts: "Theme shortcuts", system: "System", light: "Light", dark: "Dark", language: "Language",
	chat: "Conversation", taskPanel: "TillDone task panel", taskList: "TASK LIST", empty: "Ask Pi to plan a task and work through it.",
	message: "Message Pi", keyboard: "Enter to send · Shift+Enter for a new line", placeholder: "What would you like to get done?",
	delivery: "Message delivery while running", steer: "Steer now", followUp: "Follow up", stop: "Stop", send: "Send",
	connecting: "Connecting to Pi…", ready: "Ready for a prompt", busy: "Running · choose message delivery", restartHint: "Restart Pi to continue",
	disconnected: "Pi disconnected", reportedError: "Pi reported an error", restart: "Restart Pi", diagnostics: "Pi diagnostics",
	thinking: "Thinking", running: "● Running", idle: "○ Idle", noActive: "No active task", done: "done", working: "Working on",
	assistant: "Assistant", user: "You", nudge: "TillDone nudge", notice: "Notification", args: "Arguments", result: "Result",
	toolRunning: "running", toolDone: "done", toolError: "error", taskIdle: "idle", taskInprogress: "in progress", taskDone: "done",
	deny: "Deny", allow: "Allow", closesIn: "Closes in", seconds: "s",
	split: "Split", splitTitle: "Ask Pi to break this task into smaller subtasks", splitRequest: "Split task #{id} \"{text}\" into smaller subtasks with tilldone split (id={id}), then continue.",
	newSession: "New session", newSessionTitle: "Start a new session?", newSessionMessage: "Pi restarts: the conversation and task list are cleared, and the model forgets everything before.", cancel: "Cancel", newSessionConfirm: "Start new session",
};
export function copyFor(language: Preferences["language"]): Copy { return language === "en" ? en : zh; }
export function appearanceView(preferences: Preferences, systemDark: boolean) {
	const ui = copyFor(preferences.language);
	const shortcuts = FEATURED_THEMES.map((theme) => ({ id: theme.id, icon: theme.icon,
		label: preferences.language === "en" ? theme.en : theme.zh, selected: preferences.theme === theme.id }));
	return {
		...preferences,
		resolvedTheme: preferences.theme === "system" ? systemDark ? "dark" : "light" : preferences.theme,
		options: [
			{ id: "system", label: ui.system }, { id: "light", label: ui.light }, { id: "dark", label: ui.dark },
			...shortcuts.map(({ id, label }) => ({ id, label })),
		],
		shortcuts,
	};
}
