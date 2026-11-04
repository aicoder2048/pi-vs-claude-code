/**
 * TillDone Desk L4: render JSON views and send user intents through the narrow bridge.
 * No RPC parsing, domain imports, business state, or client-side clock. Only DOM presentation persists.
 */
import { renderApi, setupApi, type ApiView } from "./api-settings.ts";
import { markdownFragment, markdownTree } from "./markdown.ts";
interface View {
	api: ApiView;
	ui: Record<string, string>;
	appearance: { theme: string; resolvedTheme: string; language: string;
		options: { id: string; label: string }[];
		shortcuts: { id: string; label: string; icon: string; selected: boolean }[] };
	connection: string; error: string; diagnostics: string;
	status: { model: string; thinking: string; running: boolean; cwd: string; tilldone: string };
	poteto: { available: boolean; active: boolean };
	input: { enabled: boolean; running: boolean; newSession: boolean; images: boolean };
	tasks: { title: string; description: string; progress: string; total: number; done: number; current: string; focus: number; filterTitle: string;
		items: { id: number; label: string; text: string; status: string; statusLabel: string; icon: string; current: boolean; filtered: boolean; splittable: boolean; splitting: boolean;
			toolCallsLabel: string; toolCallsTitle: string; heavy: boolean; modelCallsLabel: string; modelCallsTitle: string }[];
		nudges: { label: string; title: string; target: string } | null };
	handoff: string | null;
	queued: string[];
	activity: { text: string; elapsed: string; total: string; lastActivity: string; stale: boolean;
		children: { agent: string; status: string; icon: string; text: string; nested: string; stale: boolean }[] } | null;
	filter: { label: string; clear: string } | null;
	conversation: (Entry | { kind: "tools"; id: string; summary: string; tone: "error" | "change" | "quiet" | "normal"; open: boolean; tools: Entry[] })[];
	dialog: { id: string; kind: "confirm" | "select" | "input" | "editor"; title: string; message: string; options: string[]; placeholder: string; prefill: string; remainingSeconds: number | null } | null;
}
type Entry = { id: string; kind: "assistant" | "user" | "nudge" | "notice" | "tool"; label: string; text: string; images: number; error: string; args: string; result: string; copyable: boolean;
	summary: string; outcome: string; outcomeTone: string };
declare global {
	interface Window { tilldone: { send(intent: unknown): Promise<{ ok: boolean; error?: string }>; onView(callback: (view: View) => void): () => void } }
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function setText(id: string, value: string) {
	const element = $(id);
	// Replacing option text, even with identical text, invalidates native select popups.
	if (element.textContent !== value) element.textContent = value;
}
function setSelectValue(id: string, value: string) {
	const select = $<HTMLSelectElement>(id);
	if (select.value !== value) select.value = value;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, content = "") {
	const element = document.createElement(tag); element.textContent = content; return element;
}
// Source each assistant body was last rendered from, so unchanged messages are not re-parsed on every view.
const renderedMarkdown = new WeakMap<Element, string>();
function setMarkdown(element: Element, source: string) {
	if (renderedMarkdown.get(element) === source) return;
	renderedMarkdown.set(element, source);
	element.replaceChildren(markdownFragment(markdownTree(source)));
}
const SVG = "http://www.w3.org/2000/svg";
function icon(className: string, shapes: [string, Record<string, string>][]) {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true"); svg.classList.add(className);
	for (const [tag, attributes] of shapes) {
		const shape = document.createElementNS(SVG, tag);
		for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
		svg.append(shape);
	}
	return svg;
}
/** The reply's Markdown source goes to the clipboard through the main process; the renderer holds no clipboard permission. */
function copyButton(id: string) {
	const button = node("button");
	button.type = "button"; button.className = "copy";
	button.append(icon("icon-copy", [["rect", { x: "5.5", y: "5.5", width: "8", height: "8", rx: "1.5" }], ["path", { d: "M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" }]]),
		icon("icon-done", [["path", { d: "m3 8.5 3.2 3L13 4.5" }]]));
	button.onclick = () => {
		void send({ type: "copyMessage", id }).then((ok) => { if (ok) button.classList.add("copied"); labelCopy(button); });
	};
	// The check mark stays until the pointer or focus moves on, so no timer is needed.
	const reset = () => { button.classList.remove("copied"); labelCopy(button); };
	button.addEventListener("mouseleave", reset); button.addEventListener("blur", reset);
	return button;
}
function labelCopy(button: HTMLElement) {
	const label = button.classList.contains("copied") ? latest?.ui.copied ?? "" : latest?.ui.copy ?? "";
	if (button.title !== label) { button.title = label; button.setAttribute("aria-label", label); }
}
async function send(intent: unknown): Promise<boolean> {
	try {
		const reply = await window.tilldone.send(intent);
		$("send-error").hidden = reply.ok;
		setText("send-error", reply.error ?? "");
		return reply.ok;
	} catch (error) { $("send-error").hidden = false; setText("send-error", String(error)); return false; }
}
function renderAppearance(view: View) {
	const root = document.documentElement;
	const appearance = view.appearance;
	if (root.lang !== appearance.language) root.lang = appearance.language;
	if (root.dataset.theme !== appearance.resolvedTheme) {
		const changing = root.dataset.theme !== undefined;
		root.dataset.theme = appearance.resolvedTheme;
		if (changing && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			// Presentation-only fade: no timers, no cached model, and no repeated animation on clock ticks.
			for (const animation of document.body.getAnimations()) if (animation.id === "theme-switch") animation.cancel();
			const animation = document.body.animate([{ opacity: 0.8 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
			animation.id = "theme-switch";
		}
	}
	for (const option of appearance.options) {
		let element = document.getElementById(`theme-${option.id}`) as HTMLOptionElement | null;
		if (!element) { element = node("option"); element.id = `theme-${option.id}`; element.value = option.id; $("theme").append(element); }
		setText(element.id, option.label);
	}
	setSelectValue("theme", appearance.theme);
	setSelectValue("language", appearance.language);
	$("theme-shortcuts").setAttribute("aria-label", view.ui.themeShortcuts);
	for (const theme of appearance.shortcuts) {
		let button = document.getElementById(`shortcut-${theme.id}`) as HTMLButtonElement | null;
		if (!button) {
			button = node("button"); button.type = "button"; button.id = `shortcut-${theme.id}`;
			button.className = "theme-swatch"; button.dataset.themeId = theme.id;
			const icon = node("span", theme.icon); icon.className = "theme-icon"; icon.setAttribute("aria-hidden", "true");
			const label = node("span"); label.id = `shortcut-label-${theme.id}`;
			button.append(icon, label);
			button.onclick = () => { void send({ type: "preferences", preferences: { theme: theme.id, language: $<HTMLSelectElement>("language").value } }); };
			$("theme-shortcuts").append(button);
		}
		setText(`shortcut-label-${theme.id}`, theme.label);
		if (button.getAttribute("aria-pressed") !== String(theme.selected)) button.setAttribute("aria-pressed", String(theme.selected));
	}
}
window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (event) => {
	if (event.matches) for (const animation of document.body.getAnimations()) if (animation.id === "theme-switch") animation.cancel();
});
// Pasted images are a draft like the textarea's text: presentation state until sent.
interface Attachment { mimeType: string; data: string; url: string }
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"], MAX_IMAGES = 10, MAX_IMAGE_BYTES = 20 * 1024 * 1024;
let attachments: Attachment[] = [];
let latest: View | undefined;
function notice(text: string) { $("send-error").hidden = !text; setText("send-error", text); }
function renderAttachments() {
	const strip = $("attachments");
	strip.hidden = attachments.length === 0;
	strip.replaceChildren(...attachments.map((attachment) => {
		const figure = node("figure"), img = node("img"), remove = node("button", "×");
		img.src = attachment.url; img.alt = latest?.ui.image ?? "";
		remove.type = "button"; remove.setAttribute("aria-label", latest?.ui.removeImage ?? "");
		remove.onclick = () => { URL.revokeObjectURL(attachment.url); attachments = attachments.filter((a) => a !== attachment); renderAttachments(); };
		figure.append(img, remove);
		return figure;
	}));
}
const base64Of = (file: File) => new Promise<string>((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(file);
});
$("prompt").addEventListener("paste", (event) => {
	const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
	if (!files.length || !latest) return;
	// Keep a plain text paste working; an image-only clipboard (a screenshot) has no text to lose.
	if (!event.clipboardData!.types.includes("text/plain")) event.preventDefault();
	if (!latest.input.images) { notice(latest.ui.imagesUnsupported); return; }
	const ui = latest.ui;
	void (async () => {
		for (const file of files) {
			if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES || attachments.length >= MAX_IMAGES) { notice(ui.imageRejected); continue; }
			// Read first, then append: spreading `attachments` before the await would let concurrent pastes overwrite each other.
			const data = await base64Of(file);
			attachments = [...attachments, { mimeType: file.type, data, url: URL.createObjectURL(file) }];
			renderAttachments();
		}
	})();
});
function render(view: View) {
	const ui = view.ui;
	latest = view;
	renderAppearance(view);
	renderApi(view.api);
	if (document.title !== ui.productName) document.title = ui.productName;
	for (const [id, key] of Object.entries({ "product-name": "productName", "brand-slogan": "slogan", "brand-logo-title": "logo", workspace: "workspace", "settings-label": "settings", "settings-title": "settings", "theme-label": "theme", "language-label": "language",
		"message-label": "message", "keyboard-hint": "keyboard",
		stop: "stop", send: "send", restart: "restart", "task-list-label": "taskList",
		"diagnostics-label": "diagnostics", deny: "deny", allow: "allow", "ask-cancel": "cancel", "ask-ok": "answerOk", "new-session-label": "newSession", "new-session-title": "newSessionTitle",
		"new-session-message": "newSessionMessage", "new-session-cancel": "cancel", "new-session-confirm": "newSessionConfirm" })) setText(id, ui[key]);
	$<HTMLTextAreaElement>("prompt").placeholder = ui.placeholder;
	$("chat").setAttribute("aria-label", ui.chat);
	$("tasks").setAttribute("aria-label", ui.taskPanel);
	setText("model", view.status.model);
	setText("thinking", `${ui.thinking}: ${view.status.thinking}`);
	setText("running", view.status.running ? ui.running : ui.idle);
	setText("tilldone-status", view.status.tilldone);
	setText("cwd", view.status.cwd);
	$("alert").hidden = view.connection !== "exited" && !view.error;
	setText("connection", view.connection === "exited" ? ui.disconnected : ui.reportedError);
	setText("error", view.error);
	$("restart").hidden = view.connection !== "exited";
	$("diagnostics").hidden = !view.diagnostics;
	setText("stderr", view.diagnostics);
	$<HTMLButtonElement>("send").disabled = !view.input.enabled;
	renderPoteto(view.poteto, ui);
	$<HTMLButtonElement>("new-session").disabled = !view.input.newSession;
	const newSessionDialog = $<HTMLDialogElement>("new-session-dialog");
	if (!view.input.newSession && newSessionDialog.open) newSessionDialog.close();
	$<HTMLButtonElement>("stop").disabled = !view.input.enabled || !view.input.running;
	const queued = $("queued");
	queued.hidden = view.queued.length === 0;
	const queuedSignature = JSON.stringify([view.queued, ui.queued]);
	if (queued.dataset.signature !== queuedSignature) {
		queued.dataset.signature = queuedSignature;
		queued.replaceChildren(...view.queued.map((message) => node("li", `⏳ ${ui.queued} · ${message}`)));
	}
	renderActivity(view.activity);
	const handoff = $("handoff");
	if (handoff.hidden !== !view.handoff) handoff.hidden = !view.handoff;
	setText("handoff", view.handoff ?? "");
	setText("input-hint", !view.input.enabled ? view.connection === "exited" ? ui.restartHint : ui.connecting : view.input.running ? ui.busy : ui.ready);

	renderFilter(view.filter);
	const conversation = $("conversation");
	const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 70;
	if (!view.conversation.length) {
		if (!conversation.querySelector(".empty")) { const empty = node("p"); empty.className = "empty"; conversation.replaceChildren(empty); }
		conversation.querySelector(".empty")!.textContent = ui.empty;
	} else {
		conversation.querySelector(".empty")?.remove();
		placeKeyed(conversation, view.conversation, (item, element) => {
			if (item.kind === "tools") return renderGroup(item, element, ui);
			element ??= messageElement(item);
			[item.label, item.text, item.error, item.images ? `🖼 ${ui.image} ×${item.images}` : ""].forEach((value, index) => {
				const child = element!.children[index];
				if (item.kind === "assistant" && index === 1) setMarkdown(child, value);
				else if (item.kind === "nudge" && index === 1) renderNudgeBody(child, item, ui);
				else if (child.textContent !== value) child.textContent = value;
			});
			const copy = element.querySelector<HTMLButtonElement>("button.copy");
			if (copy) { if (copy.hidden === item.copyable) copy.hidden = !item.copyable; labelCopy(copy); }
			return element;
		});
	}
	if (atBottom) conversation.scrollTop = conversation.scrollHeight;

	setText("list-title", view.tasks.title); setText("list-description", view.tasks.description);
	setText("progress-label", view.tasks.progress); setText("current", view.tasks.current);
	const progress = $<HTMLProgressElement>("progress"); progress.max = Math.max(1, view.tasks.total); progress.value = view.tasks.done;
	const nudges = $<HTMLButtonElement>("nudges");
	if (nudges.hidden !== !view.tasks.nudges) nudges.hidden = !view.tasks.nudges;
	if (view.tasks.nudges) {
		setText("nudges", view.tasks.nudges.label);
		nudges.title = view.tasks.nudges.title; nudges.dataset.target = view.tasks.nudges.target;
	}
	// Rebuild the list only when its content changes, not on every streamed view.
	const taskList = $("task-list");
	const taskSignature = JSON.stringify([view.tasks.items, ui.split, ui.splitting, view.tasks.filterTitle]);
	if (taskList.dataset.signature !== taskSignature) {
		taskList.dataset.signature = taskSignature;
		// The list is rebuilt, so keyboard focus moves to the rebuilt row it was on.
		const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#task-list li")?.dataset.id;
		taskList.replaceChildren(...view.tasks.items.map((task) => {
			const li = node("li");
			li.className = task.current ? "current" : task.status;
			li.dataset.id = String(task.id); li.dataset.filtered = String(task.filtered);
			li.tabIndex = 0; li.title = view.tasks.filterTitle;
			li.setAttribute("aria-label", `${task.statusLabel}: ${task.text}`);
			li.append(node("span", `${task.icon}  ${task.label}  ${task.text}`));
			if (task.modelCallsLabel || task.toolCallsLabel) {
				const counts = node("span"); counts.className = "counts";
				if (task.modelCallsLabel) {
					const calls = node("small", task.modelCallsLabel);
					calls.className = "model-calls"; calls.title = task.modelCallsTitle;
					counts.append(calls);
				}
				if (task.toolCallsLabel) {
					const calls = node("small", task.toolCallsLabel);
					calls.className = task.heavy ? "tool-calls heavy" : "tool-calls"; calls.title = task.toolCallsTitle;
					counts.append(calls);
				}
				li.append(counts);
			}
			if (task.splittable) {
				const split = node("button", task.splitting ? ui.splitting : ui.split);
				split.type = "button"; split.className = "split"; split.title = ui.splitTitle; split.disabled = task.splitting;
				split.setAttribute("aria-label", `${ui.split} #${task.id}`);
				split.onclick = () => { void send({ type: "splitTask", id: task.id }); };
				li.append(split);
			}
			return li;
		}));
		if (focused) taskList.querySelector<HTMLElement>(`li[data-id="${focused}"]`)?.focus();
	}
	const panel = $("tasks");
	if (panel.dataset.focus !== String(view.tasks.focus)) {
		panel.dataset.focus = String(view.tasks.focus);
		if (view.tasks.focus) panel.focus();
	}
	renderConfirm(view.dialog?.kind === "confirm" ? view.dialog : null, ui);
	renderAsk(view.dialog && view.dialog.kind !== "confirm" ? view.dialog : null, ui);
}
/** Puts one element per item in order, reusing elements by key; DOM nodes move only when out of place. */
function placeKeyed<T extends { id: string }>(parent: HTMLElement, items: readonly T[], render: (item: T, element: HTMLElement | undefined) => HTMLElement) {
	const existing = new Map(Array.from(parent.children).map((el) => [(el as HTMLElement).dataset.key, el as HTMLElement]));
	let cursor = parent.firstElementChild;
	for (const item of items) {
		const element = render(item, existing.get(item.id));
		element.dataset.key = item.id;
		existing.delete(item.id);
		if (element === cursor) cursor = cursor.nextElementSibling;
		else parent.insertBefore(element, cursor);
	}
	for (const element of existing.values()) element.remove();
}
function messageElement(item: Entry) {
	const element = node("article"); element.className = `message ${item.kind}`;
	const error = node("p"); error.className = "message-error";
	const images = node("p"); images.className = "message-images";
	// Assistant replies are Markdown; user and notice text is shown as written.
	// A nudge leads with its meaning and outcome; the text the model saw stays verbatim behind a fold.
	const body = item.kind === "assistant" || item.kind === "nudge" ? node("div") : node("p");
	if (item.kind === "assistant") body.className = "markdown";
	if (item.kind === "nudge") {
		body.className = "nudge-body";
		const summary = node("p"); summary.className = "nudge-summary";
		const outcome = node("p"); outcome.className = "nudge-outcome";
		const raw = node("details"); raw.className = "nudge-raw";
		raw.append(node("summary"), node("p"));
		body.append(summary, outcome, raw);
	}
	element.append(node("h3"), body, error, images);
	if (item.kind === "assistant") element.append(copyButton(item.id));
	return element;
}
function renderNudgeBody(body: Element, item: Entry, ui: View["ui"]) {
	const [summary, outcome, raw] = Array.from(body.children) as HTMLElement[];
	if (summary.textContent !== item.summary) summary.textContent = item.summary;
	if (outcome.textContent !== item.outcome) outcome.textContent = item.outcome;
	if (outcome.dataset.tone !== item.outcomeTone) outcome.dataset.tone = item.outcomeTone;
	const [label, text] = Array.from(raw.children) as HTMLElement[];
	if (label.textContent !== ui.nudgeRaw) label.textContent = ui.nudgeRaw;
	if (text.textContent !== item.text) text.textContent = item.text;
}
function renderGroup(group: Extract<View["conversation"][number], { kind: "tools" }>, element: HTMLElement | undefined, ui: View["ui"]) {
	if (!element) {
		element = node("details"); element.className = "tools";
		const list = node("div"); list.className = "tools-list";
		element.append(node("summary"), list);
	}
	const details = element as HTMLDetailsElement;
	if (details.dataset.tone !== group.tone) details.dataset.tone = group.tone;
	// The view opens a group when it gains a failure; otherwise the user's own toggle stands.
	if (details.dataset.open !== String(group.open)) { details.dataset.open = String(group.open); details.open = group.open; }
	if (details.children[0].textContent !== group.summary) details.children[0].textContent = group.summary;
	placeKeyed(details.children[1] as HTMLElement, group.tools, (tool, card) => {
		if (!card) { card = node("details"); card.className = "tool"; card.append(node("summary"), node("pre"), node("pre")); }
		[tool.label, `${ui.args}\n${tool.args}`, `${ui.result}\n${tool.result}`].forEach((value, index) => {
			if (card!.children[index].textContent !== value) card!.children[index].textContent = value;
		});
		return card;
	});
	return details;
}
function renderFilter(filter: View["filter"]) {
	$("filter-bar").hidden = !filter;
	if (!filter) return;
	setText("filter-label", filter.label);
	setText("filter-clear", filter.clear);
}
function renderActivity(activity: View["activity"]) {
	$("activity").hidden = !activity;
	if (!activity) return;
	const stale = String(activity.stale);
	if ($("activity").dataset.stale !== stale) $("activity").dataset.stale = stale;
	setText("activity-text", `${activity.text} · ${activity.elapsed}`);
	setText("activity-meta", [activity.total, activity.lastActivity].filter(Boolean).join(" · "));
	const list = $("activity-children");
	const signature = JSON.stringify(activity.children);
	if (list.dataset.signature === signature) return;
	list.dataset.signature = signature;
	list.hidden = activity.children.length === 0;
	list.replaceChildren(...activity.children.map((child) => {
		const li = node("li");
		li.dataset.status = child.status; li.dataset.stale = String(child.stale);
		const icon = node("span", child.icon); icon.className = "child-icon"; icon.setAttribute("aria-hidden", "true");
		const text = node("span", child.text); text.className = "child-text";
		li.append(icon, text);
		if (child.nested) { const nested = node("small", `↳ ${child.nested}`); nested.className = "child-nested"; li.append(nested); }
		return li;
	}));
}
// Read-only: Poteto Mode follows how the desk was started (TILLDONE_PSTACK=1), there is no switch.
function renderPoteto(poteto: View["poteto"], ui: View["ui"]) {
	const badge = $("poteto");
	badge.hidden = !poteto.available;
	badge.dataset.state = poteto.active ? "on" : "pending";
	setText("poteto", poteto.active ? ui.potetoOn : ui.potetoPending);
	badge.title = ui.potetoTitle;
}
const countdown = (seconds: number | null, ui: View["ui"]) => seconds === null ? "" : `${ui.closesIn} ${seconds} ${ui.seconds}`;
function renderConfirm(confirm: View["dialog"], ui: View["ui"]) {
	const dialog = $<HTMLDialogElement>("confirm-dialog");
	if (confirm) {
		setText("confirm-title", confirm.title); setText("confirm-message", confirm.message);
		setText("countdown", countdown(confirm.remainingSeconds, ui));
		$("allow").onclick = () => { void send({ type: "confirm", id: confirm.id, confirmed: true }); };
		$("deny").onclick = () => { void send({ type: "confirm", id: confirm.id, confirmed: false }); };
		dialog.oncancel = (event) => { event.preventDefault(); void send({ type: "confirm", id: confirm.id, confirmed: false }); };
		if (!dialog.open) { dialog.showModal(); $("deny").focus(); }
	} else if (dialog.open) dialog.close();
}
// select: one button per option; input/editor: a field and OK. Esc or Cancel cancels.
// Fields and options are filled once per dialog id, so view updates (countdown ticks) keep what the user typed.
function renderAsk(ask: View["dialog"], ui: View["ui"]) {
	const dialog = $<HTMLDialogElement>("ask-dialog");
	if (!ask) { if (dialog.open) dialog.close(); dialog.dataset.id = ""; return; }
	const answer = (value: string | null) => { void send({ type: "answer", id: ask.id, value }); };
	const input = $<HTMLInputElement>("ask-input"), editor = $<HTMLTextAreaElement>("ask-editor");
	setText("ask-title", ask.title);
	setText("ask-countdown", countdown(ask.remainingSeconds, ui));
	if (dialog.dataset.id !== ask.id) {
		dialog.dataset.id = ask.id;
		dialog.dataset.kind = ask.kind;
		const options = $("ask-options");
		options.replaceChildren(...ask.options.map((option) => {
			const button = document.createElement("button");
			button.type = "button"; button.textContent = option;
			button.onclick = () => answer(option);
			return button;
		}));
		options.hidden = ask.kind !== "select";
		input.hidden = ask.kind !== "input"; input.value = ""; input.placeholder = ask.placeholder;
		editor.hidden = ask.kind !== "editor"; editor.value = ask.prefill;
		$("ask-ok").hidden = ask.kind === "select";
	}
	$("ask-cancel").onclick = () => answer(null);
	$("ask-ok").onclick = () => answer(ask.kind === "editor" ? editor.value : input.value);
	input.onkeydown = (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); answer(input.value); } };
	dialog.oncancel = (event) => { event.preventDefault(); answer(null); };
	if (!dialog.open) {
		dialog.showModal();
		(ask.kind === "select" ? $("ask-options").querySelector("button") : ask.kind === "input" ? input : editor)?.focus();
	}
}
// Links in replies open in the system browser; the main process checks the address against the reply first.
function openLink(event: Event) {
	const link = (event.target as Element).closest<HTMLElement>(".markdown .link");
	const message = link?.closest<HTMLElement>(".message");
	if (!link || !message?.dataset.key) return;
	event.preventDefault();
	void send({ type: "openLink", id: message.dataset.key, url: link.title });
}
$("conversation").addEventListener("click", openLink);
$("conversation").addEventListener("keydown", (event) => { if (event.key === "Enter") openLink(event); });
$("composer").addEventListener("submit", (event) => {
	event.preventDefault();
	const input = $<HTMLTextAreaElement>("prompt");
	const message = input.value;
	const sent = attachments;
	if (!message.trim() && !sent.length) return;
	// The model may have changed since the images were pasted.
	if (sent.length && !latest?.input.images) { notice(latest?.ui.imagesUnsupported ?? ""); return; }
	void send({ type: "submit", message, images: sent.map(({ mimeType, data }) => ({ mimeType, data })) }).then((ok) => {
		if (!ok) return;
		if (input.value === message) input.value = "";
		for (const attachment of sent) URL.revokeObjectURL(attachment.url);
		attachments = attachments.filter((attachment) => !sent.includes(attachment));
		renderAttachments();
	});
});
$("prompt").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault(); if (!$<HTMLButtonElement>("send").disabled) $<HTMLFormElement>("composer").requestSubmit();
	}
});
// A task row filters the conversation to that task; its split button and counts keep their own behavior.
function filterFromRow(event: Event) {
	if ((event.target as Element).closest("button")) return;
	const row = (event.target as Element).closest<HTMLElement>("#task-list li");
	if (row?.dataset.id) void send({ type: "filterTask", id: Number(row.dataset.id) });
}
$("task-list").addEventListener("click", filterFromRow);
$("task-list").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.target as Element).matches("li")) filterFromRow(event); });
$("filter-clear").onclick = () => { void send({ type: "filterTask", id: null }); };
$("nudges").onclick = () => {
	const target = $("nudges").dataset.target;
	if (!target) return;
	const message = Array.from($("conversation").children).find((el) => (el as HTMLElement).dataset.key === target);
	message?.scrollIntoView({ behavior: "smooth", block: "center" });
};
$("stop").onclick = () => { void send({ type: "abort" }); };
$("restart").onclick = () => { void send({ type: "restart" }); };
$("new-session").onclick = () => { const dialog = $<HTMLDialogElement>("new-session-dialog"); dialog.showModal(); $("new-session-cancel").focus(); };
$("new-session-cancel").onclick = () => { $<HTMLDialogElement>("new-session-dialog").close(); };
$("new-session-confirm").onclick = () => { $<HTMLDialogElement>("new-session-dialog").close(); void send({ type: "newSession" }); };
function saveAppearance() {
	void send({ type: "preferences", preferences: { theme: $<HTMLSelectElement>("theme").value, language: $<HTMLSelectElement>("language").value } });
}
$("theme").addEventListener("change", saveAppearance);
$("language").addEventListener("change", saveAppearance);
setupApi(send);
const unsubscribe = window.tilldone.onView(render);
window.addEventListener("unload", unsubscribe, { once: true });
export {};
