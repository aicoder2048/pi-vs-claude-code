/** TillDone Desk L3 tests: appearance defaults, validation, system resolution, and localized views. */
import { expect, test } from "bun:test";
import { DEFAULT_PREFERENCES, parsePreferences, THEME_IDS } from "../src/appearance.ts";
import { initialState, parseIntent, planIntent, reduce, toViewModel } from "../src/domain.ts";

test("default interface is Simplified Chinese and follows system appearance", () => {
	const s = initialState("model", "/work");
	const vm = toViewModel(s);
	expect(vm.appearance).toMatchObject({ theme: "system", language: "zh-CN", resolvedTheme: "light" });
	expect(vm.ui.send).toBe("发送");
	expect(vm.ui.settings).toBe("设置");
	expect(vm.ui.system).toBe("系统");
	expect(vm.ui.language).toBe("语言");
	expect(vm.tasks.current).toBe("暂无进行中的任务");
	expect(toViewModel(reduce(s, { type: "desk_system_theme", dark: true })).appearance.resolvedTheme).toBe("dark");
	expect(DEFAULT_PREFERENCES).toEqual({ theme: "system", language: "zh-CN" });
});
test("product name, slogan, and logo label follow language in every theme", () => {
	for (const theme of THEME_IDS) {
		const zh = toViewModel(initialState("model", "/work", { theme, language: "zh-CN" })).ui;
		const en = toViewModel(initialState("model", "/work", { theme, language: "en" })).ui;
		expect(zh.productName).toBe("边牧任务桌面");
		expect(zh.slogan).toBe("交给边牧(AI牧羊犬)，安心放牧(任务必达)");
		expect(zh.logo).toBe("AI 边牧标志");
		expect(zh.workspace).toBe("PI · 任务工作台");
		expect(en.productName).toBe("TillDone Desk");
		expect(en.slogan).toBe("Don't stop until it's done");
		expect(en.logo).toBe("AI border collie logo");
		expect(en.workspace).toBe("PI · TASK WORKSPACE");
	}
});
test("explicit themes override the system; language changes view labels, not task data", () => {
	const start = initialState("model", "/work", undefined, true);
	const intent = parseIntent({ type: "preferences", preferences: { theme: "light", language: "en" } })!;
	const plan = planIntent(start, intent);
	expect(plan.commands).toHaveLength(0);
	const s = plan.events.reduce(reduce, start);
	const vm = toViewModel(s);
	expect(vm.appearance.resolvedTheme).toBe("light");
	expect(vm.ui.send).toBe("Send");
	expect(vm.tasks.current).toBe("No active task");
	expect(s.list).toBe(start.list);
	const dark = reduce(s, { type: "desk_preferences", preferences: { theme: "dark", language: "zh-CN" } });
	expect(toViewModel(reduce(dark, { type: "desk_system_theme", dark: false })).appearance.resolvedTheme).toBe("dark");
});
test("all seven themes are allowed, localized, and independent of the OS outside system mode", () => {
	for (const theme of THEME_IDS) {
		const preferences = { theme, language: "zh-CN" as const };
		expect(parsePreferences(preferences)).toEqual(preferences);
		const initial = initialState("model", "/work");
		const intent = parseIntent({ type: "preferences", preferences })!;
		const plan = planIntent(initial, intent);
		expect(plan.commands).toHaveLength(0);
		const state = plan.events.reduce(reduce, initial);
		const vm = toViewModel(state);
		expect(vm.appearance.options.map((option) => option.id)).toEqual([...THEME_IDS]);
		expect(vm.appearance.shortcuts.filter((item) => item.selected).map((item): string => item.id)).toEqual(["paper", "night", "ink", "neon"].includes(theme) ? [theme] : []);
		if (theme !== "system") expect(toViewModel(reduce(state, { type: "desk_system_theme", dark: true })).appearance.resolvedTheme).toBe(theme);
		expect(state.list).toBe(initial.list);
		expect(state.messages).toBe(initial.messages);
	}
	const zh = toViewModel(initialState("model", "/work")).appearance.shortcuts;
	const en = toViewModel(initialState("model", "/work", { theme: "paper", language: "en" })).appearance.shortcuts;
	expect(zh.map((theme) => theme.label)).toEqual(["素纸", "星夜", "水墨", "霓虹"]);
	expect(en.map((theme) => theme.label)).toEqual(["Paper", "Night", "Ink", "Neon"]);
	expect(zh.every((theme) => theme.icon.length > 0)).toBe(true);
});
test("malformed preferences are rejected at persistence and intent boundaries", () => {
	for (const raw of [null, {}, { theme: "sepia", language: "en" }, { theme: "system", language: "fr" }, { theme: "dark" }]) {
		expect(parsePreferences(raw)).toBeUndefined();
		expect(parseIntent({ type: "preferences", preferences: raw })).toBeUndefined();
	}
});
