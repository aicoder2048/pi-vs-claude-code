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
	productName: "边牧", slogan: "羊不进圈，边牧不歇", logo: "AI 边牧标志",
	workspace: "PI · 任务工作台", settings: "设置", theme: "主题", themeShortcuts: "快捷切换主题", system: "系统", light: "浅色", dark: "深色", language: "语言",
	chat: "对话", taskPanel: "TillDone 任务面板", taskList: "任务列表", empty: "让 Pi 制定计划，并逐项完成任务。",
	message: "发送消息给 Pi", keyboard: "Enter 发送 · Shift+Enter 换行 · Ctrl/⌘+V 粘贴图片", placeholder: "你想完成什么任务？",
	stop: "停止", send: "发送", queued: "待送达",
	connecting: "正在连接 Pi…", ready: "可以发送新任务", busy: "运行中 · 消息会在下一步送达边牧", restartHint: "重启 Pi 后继续", resumeUnavailable: "没有找到上次会话的记录，已开始新会话。",
	disconnected: "Pi 已断开连接", reportedError: "Pi 报告了错误", restart: "重启 Pi", diagnostics: "Pi 诊断信息",
	thinking: "思考深度", running: "● 运行中", idle: "○ 空闲", noActive: "暂无进行中的任务", done: "已完成", working: "当前任务",
	assistant: "助手", user: "你", nudge: "提醒继续", notice: "通知", args: "参数", result: "结果",
	toolRunning: "执行中", toolDone: "已完成", toolError: "出错", taskIdle: "未开始", taskInprogress: "进行中", taskDone: "已完成",
	deny: "拒绝", allow: "允许", answerOk: "确定", closesIn: "自动关闭倒计时", seconds: "秒",
	image: "图片", removeImage: "移除图片", imagesUnsupported: "当前模型不支持图片输入，图片未添加。", imageRejected: "只能粘贴 PNG、JPEG、GIF 或 WebP，单张不超过 20 MB，最多 10 张。",
	split: "细分", splitting: "细分中…", splitTitle: "让边牧把这个任务拆成更小的子任务", splitRequest: "请把任务 #{id}「{text}」细分成更小的子任务：用 tilldone split（id={id}）原位替换，然后继续。",
	copy: "复制 Markdown", copied: "已复制",
	toolCallOne: "1 工具", toolCalls: "{n} 工具", toolCallsTitle: "这个任务进行期间边牧调用其他工具的次数（不含管理清单的 tilldone 调用）；每满 {every} 次会提醒边牧考虑细分",
	modelCallOne: "1 模型", modelCalls: "{n} 模型", modelCallsTitle: "这个任务进行期间边牧请求大模型的次数：每次请求是一个 turn，一次回复里可能带若干个工具调用",
	potetoOn: "Poteto 模式", potetoPending: "Poteto 模式 · 首条消息开启", potetoTitle: "用 TILLDONE_PSTACK=1（just tilldone-with-pstack）启动：每个会话的第一条消息会开启 pstack 的 Poteto 模式（规划、按 playbook 做事、必要时分派 subagent）。不想用就用 just tilldone 启动。", newSession: "新会话", newSessionTitle: "开始新会话？", newSessionMessage: "将重启 Pi：当前对话和任务清单都会清空，模型不再记得之前的内容。", cancel: "取消", newSessionConfirm: "开始新会话",
	nowThinking: "模型思考中", nowCompacting: "压缩上下文中", nowTool: "执行 {name}", nowToolDetail: "执行 {name}：{detail}",
	nowSubagentOne: "等待 1 个子 agent", nowSubagents: "等待 {n} 个子 agent", nowCounts: "（{counts}）", nowDone: "{n} 个完成", nowFailed: "{n} 个失败", listSeparator: "，",
	runTotal: "本次运行 {d}", lastActivity: "最后动静：{d}前",
	durationSeconds: "{s} 秒", durationMinutes: "{m} 分 {s} 秒", durationHours: "{h} 小时 {m} 分",
	childPending: "排队中", childRunning: "运行 {d}", childDone: "完成 · 用时 {d}", childFailed: "失败", childTurns: "{n} 轮", childTokens: "{n} tokens", childNestedOne: "转包 1 个子 agent", childNested: "转包 {n} 个子 agent",
	groupReadOne: "读取 {file}", groupRead: "读取 {n} 个文件：{files}", groupChangeOne: "修改 {file}", groupChange: "修改 {n} 个文件：{files}",
	groupBashOne: "运行 {command}", groupBash: "运行 {n} 条命令：{command}", groupList: "更新任务清单", groupDelegate: "委派子 agent", groupOther: "{name} ×{n}",
	fileSeparator: "、", groupSeparator: "；",
	filterLabel: "只看任务 #{id}：{text}", filterClear: "显示全部", filterTitle: "点击只看这个任务期间的活动，再点一次显示全部",
	nudgeNo: "提醒边牧继续（第 {n} 次）", nudgeSummary: "这一轮干完时，还有 {n} 个任务没干完（{ids}），TillDone 提醒边牧接着干。", idSeparator: "、",
	nudgeWaiting: "提醒之后的这一轮还在进行", nudgeDone: "✓ 提醒之后干完了", nudgePartial: "◐ 提醒之后干完 {d} / {n}，{left} 还没干完", nudgeStopped: "⚠ 提醒之后没接着干，{left} 还没干完", nudgeReplaced: "清单后来换了，没法对照",
	nudgeRaw: "TillDone 发给边牧的原话",
	nudgeLineNone: "还没催过边牧", nudgeLineNoneDone: "还没催过，边牧都是自己干完的",
	nudgeLineWaiting: "催过 {n} 次，正在接着干", nudgeLineDone: "催过 {n} 次，催完就干完了", nudgeLinePartial: "催过 {n} 次，还剩 {left} 没干完",
	nudgeLineStopped: "催过 {n} 次，最后一次没接着干，等你发话", nudgeLineStoppedOnce: "催过 1 次，催完没接着干，等你发话", nudgeLineReplaced: "催过 {n} 次，清单后来换了",
	nudgeTitle: "一轮干完时清单还没做完，TillDone 会提醒边牧接着干。你每发一条消息，最多提醒一次；提醒过还停下，就该你来决定了。点这里跳到最近一次提醒。",
	nudgeTitleZero: "一轮干完时清单还没做完，TillDone 会提醒边牧接着干。到目前为止还不需要提醒。",
	handoff: "边牧停下了：{tasks} 还没干完，也已经提醒过它。你可以回复它接着干，或点任务旁的“细分”把任务拆小。",
};
export type Copy = typeof zh;
const en: Copy = {
	productName: "TillDone Desk", slogan: "Don't stop until it's done", logo: "AI border collie logo",
	workspace: "PI · TASK WORKSPACE", settings: "Settings", theme: "Theme", themeShortcuts: "Theme shortcuts", system: "System", light: "Light", dark: "Dark", language: "Language",
	chat: "Conversation", taskPanel: "TillDone task panel", taskList: "TASK LIST", empty: "Ask Pi to plan a task and work through it.",
	message: "Message Pi", keyboard: "Enter to send · Shift+Enter for a new line · Ctrl/⌘+V to paste images", placeholder: "What would you like to get done?",
	stop: "Stop", send: "Send", queued: "Waiting",
	connecting: "Connecting to Pi…", ready: "Ready for a prompt", busy: "Running · messages reach Pi at its next step", restartHint: "Restart Pi to continue", resumeUnavailable: "No saved record of the last session was found; started a new session.",
	disconnected: "Pi disconnected", reportedError: "Pi reported an error", restart: "Restart Pi", diagnostics: "Pi diagnostics",
	thinking: "Thinking", running: "● Running", idle: "○ Idle", noActive: "No active task", done: "done", working: "Working on",
	assistant: "Assistant", user: "You", nudge: "Reminder", notice: "Notification", args: "Arguments", result: "Result",
	toolRunning: "running", toolDone: "done", toolError: "error", taskIdle: "idle", taskInprogress: "in progress", taskDone: "done",
	deny: "Deny", allow: "Allow", answerOk: "OK", closesIn: "Closes in", seconds: "s",
	image: "image", removeImage: "Remove image", imagesUnsupported: "The current model does not accept images; the image was not added.", imageRejected: "Paste PNG, JPEG, GIF or WebP, up to 20 MB each and 10 in total.",
	split: "Split", splitting: "Splitting…", splitTitle: "Ask Pi to break this task into smaller subtasks", splitRequest: "Split task #{id} \"{text}\" into smaller subtasks with tilldone split (id={id}), then continue.",
	copy: "Copy Markdown", copied: "Copied",
	toolCallOne: "1 tool", toolCalls: "{n} tools", toolCallsTitle: "Other tools Pi called while this task was in progress (tilldone's own list calls not included); every {every} calls it is reminded to consider splitting",
	modelCallOne: "1 llm", modelCalls: "{n} llms", modelCallsTitle: "Model requests Pi made while this task was in progress: each request is one turn, and one reply can carry several tool calls",
	potetoOn: "Poteto Mode", potetoPending: "Poteto Mode · starts with the first message", potetoTitle: "Started with TILLDONE_PSTACK=1 (just tilldone-with-pstack): each session's first message turns on pstack Poteto Mode (plan, follow a playbook, delegate to subagents when useful). Start with just tilldone to run without it.", newSession: "New session", newSessionTitle: "Start a new session?", newSessionMessage: "Pi restarts: the conversation and task list are cleared, and the model forgets everything before.", cancel: "Cancel", newSessionConfirm: "Start new session",
	nowThinking: "Model thinking", nowCompacting: "Compacting context", nowTool: "Running {name}", nowToolDetail: "Running {name}: {detail}",
	nowSubagentOne: "Waiting on 1 subagent", nowSubagents: "Waiting on {n} subagents", nowCounts: " ({counts})", nowDone: "{n} done", nowFailed: "{n} failed", listSeparator: ", ",
	runTotal: "Run {d}", lastActivity: "Last activity {d} ago",
	durationSeconds: "{s}s", durationMinutes: "{m}m {s}s", durationHours: "{h}h {m}m",
	childPending: "queued", childRunning: "running {d}", childDone: "done in {d}", childFailed: "failed", childTurns: "{n} turns", childTokens: "{n} tokens", childNestedOne: "delegated to 1 subagent", childNested: "delegated to {n} subagents",
	groupReadOne: "Read {file}", groupRead: "Read {n} files: {files}", groupChangeOne: "Changed {file}", groupChange: "Changed {n} files: {files}",
	groupBashOne: "Ran {command}", groupBash: "Ran {n} commands: {command}", groupList: "Updated the task list", groupDelegate: "Delegated to subagents", groupOther: "{name} ×{n}",
	fileSeparator: ", ", groupSeparator: "; ",
	filterLabel: "Only task #{id}: {text}", filterClear: "Show all", filterTitle: "Click to see only this task's activity; click again to see everything",
	nudgeNo: "Asked Pi to keep going (#{n})", nudgeSummary: "This run ended with {n} task(s) not done ({ids}), so TillDone asked Pi to keep going.", idSeparator: ", ",
	nudgeWaiting: "The run after the reminder is still going", nudgeDone: "✓ Finished after the reminder", nudgePartial: "◐ Finished {d} / {n} after the reminder; {left} not done yet", nudgeStopped: "⚠ Didn't pick it up after the reminder; {left} not done yet", nudgeReplaced: "The list was replaced since; nothing to compare",
	nudgeRaw: "What TillDone told Pi",
	nudgeLineNone: "Pi hasn't needed a reminder", nudgeLineNoneDone: "No reminders; Pi finished everything on its own",
	nudgeLineWaiting: "Reminded {n}×; Pi is back at it", nudgeLineDone: "Reminded {n}×; finished after the reminder", nudgeLinePartial: "Reminded {n}×; {left} still not done",
	nudgeLineStopped: "Reminded {n}×; Pi didn't pick it up last time, your move", nudgeLineStoppedOnce: "Reminded once; Pi didn't pick it up, your move", nudgeLineReplaced: "Reminded {n}×; the list was replaced since",
	nudgeTitle: "When a run ends with the list unfinished, TillDone reminds Pi to keep going. Each message you send allows at most one reminder; if Pi stops again, the decision is yours. Click to jump to the latest reminder.",
	nudgeTitleZero: "When a run ends with the list unfinished, TillDone reminds Pi to keep going. No reminder has been needed so far.",
	handoff: "Pi stopped with {tasks} not done, and it has already been reminded. Reply to keep it going, or press Split next to a task to break it down.",
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
