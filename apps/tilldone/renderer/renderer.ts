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
	input: { enabled: boolean; running: boolean; newSession: boolean; images: boolean };
	tasks: { title: string; description: string; progress: string; total: number; done: number; current: string; focus: number;
		items: { id: number; label: string; text: string; status: string; statusLabel: string; icon: string; current: boolean; splittable: boolean; splitting: boolean;
			toolCallsLabel: string; toolCallsTitle: string; heavy: boolean; modelCallsLabel: string; modelCallsTitle: string }[] };
	queued: string[];
	conversation: { id: string; kind: string; label: string; text: string; images: number; error: string; args: string; result: string; copyable: boolean }[];
	confirm: { id: string; title: string; message: string; remainingSeconds: number | null } | null;
}
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
		"diagnostics-label": "diagnostics", deny: "deny", allow: "allow", "new-session-label": "newSession", "new-session-title": "newSessionTitle",
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
	setText("input-hint", !view.input.enabled ? view.connection === "exited" ? ui.restartHint : ui.connecting : view.input.running ? ui.busy : ui.ready);

	const conversation = $("conversation");
	const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 70;
	const existing = new Map(Array.from(conversation.children).map((el) => [(el as HTMLElement).dataset.key, el as HTMLElement]));
	if (!view.conversation.length) {
		if (!conversation.querySelector(".empty")) { const empty = node("p"); empty.className = "empty"; conversation.replaceChildren(empty); }
		conversation.querySelector(".empty")!.textContent = ui.empty;
	} else {
		conversation.querySelector(".empty")?.remove();
		for (const item of view.conversation) {
			let element = existing.get(item.id);
			if (!element) {
				if (item.kind === "tool") {
					element = node("details"); element.className = "tool";
					element.append(node("summary"), node("pre"), node("pre"));
				} else {
					element = node("article"); element.className = `message ${item.kind}`;
					const error = node("p"); error.className = "message-error";
					const images = node("p"); images.className = "message-images";
					// Assistant replies are Markdown; user, nudge and notice text is shown as written.
					const body = item.kind === "assistant" ? node("div") : node("p");
					if (item.kind === "assistant") body.className = "markdown";
					element.append(node("h3"), body, error, images);
					if (item.kind === "assistant") element.append(copyButton(item.id));
				}
				element.dataset.key = item.id; conversation.append(element);
			}
			const values = item.kind === "tool" ? [item.label, `${ui.args}\n${item.args}`, `${ui.result}\n${item.result}`]
				: [item.label, item.text, item.error, item.images ? `🖼 ${ui.image} ×${item.images}` : ""];
			values.forEach((value, index) => {
				const child = element!.children[index];
				if (item.kind === "assistant" && index === 1) setMarkdown(child, value);
				else if (child.textContent !== value) child.textContent = value;
			});
			const copy = element.querySelector<HTMLButtonElement>("button.copy");
			if (copy) { if (copy.hidden === item.copyable) copy.hidden = !item.copyable; labelCopy(copy); }
			existing.delete(item.id);
		}
		for (const element of existing.values()) element.remove();
	}
	if (atBottom) conversation.scrollTop = conversation.scrollHeight;

	setText("list-title", view.tasks.title); setText("list-description", view.tasks.description);
	setText("progress-label", view.tasks.progress); setText("current", view.tasks.current);
	const progress = $<HTMLProgressElement>("progress"); progress.max = Math.max(1, view.tasks.total); progress.value = view.tasks.done;
	// Rebuild the list only when its content changes, not on every streamed view.
	const taskList = $("task-list");
	const taskSignature = JSON.stringify([view.tasks.items, ui.split, ui.splitting]);
	if (taskList.dataset.signature !== taskSignature) {
		taskList.dataset.signature = taskSignature;
		taskList.replaceChildren(...view.tasks.items.map((task) => {
			const li = node("li");
			li.className = task.current ? "current" : task.status;
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
	}
	const panel = $("tasks");
	if (panel.dataset.focus !== String(view.tasks.focus)) {
		panel.dataset.focus = String(view.tasks.focus);
		if (view.tasks.focus) panel.focus();
	}
	const dialog = $<HTMLDialogElement>("confirm-dialog");
	if (view.confirm) {
		const confirm = view.confirm;
		setText("confirm-title", confirm.title); setText("confirm-message", confirm.message);
		setText("countdown", confirm.remainingSeconds === null ? "" : `${ui.closesIn} ${confirm.remainingSeconds} ${ui.seconds}`);
		$("allow").onclick = () => { void send({ type: "confirm", id: confirm.id, confirmed: true }); };
		$("deny").onclick = () => { void send({ type: "confirm", id: confirm.id, confirmed: false }); };
		dialog.oncancel = (event) => { event.preventDefault(); void send({ type: "confirm", id: confirm.id, confirmed: false }); };
		if (!dialog.open) { dialog.showModal(); $("deny").focus(); }
	} else if (dialog.open) dialog.close();
}
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
