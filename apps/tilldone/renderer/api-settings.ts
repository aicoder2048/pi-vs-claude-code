/** TillDone Desk L4: API settings form presentation; only new drafts live in input elements, never stored credentials. */
export interface ApiView {
	open: boolean; saving: boolean; savedRevision: number; saved: boolean; model: string; authPath: string;
	copy: Record<string, string>; error: string; canSave: boolean;
	providers: { id: string; name: string; status: string; canRemove: boolean }[];
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function setText(id: string, value: string) { if ($(id).textContent !== value) $(id).textContent = value; }
function clearInputs() {
	for (const input of Array.from($<HTMLFormElement>("api-form").querySelectorAll<HTMLInputElement>('input[type="password"], input[type="text"]'))) { input.value = ""; input.type = "password"; }
	for (const input of Array.from($<HTMLFormElement>("api-form").querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) input.checked = false;
}
export function renderApi(view: ApiView): void {
	const dialog = $<HTMLDialogElement>("api-dialog");
	if (view.open && !dialog.open) clearInputs();
	if (dialog.dataset.revision !== String(view.savedRevision)) { clearInputs(); dialog.dataset.revision = String(view.savedRevision); }
	for (const [id, key] of Object.entries({ "api-entry-label": "entry", "api-title": "title", "api-description": "description", "api-billing": "billing",
		"api-storage": "storage", "api-usage": "usage", "api-precedence": "precedence", "api-close": "close", "api-saved": "saved" })) setText(id, view.copy[key]);
	setText("api-model", `${view.copy.currentModel}: ${view.model}`);
	setText("api-auth-path", `${view.copy.authPath}: ${view.authPath}`);
	setText("api-save", view.saving ? view.copy.saving : view.copy.save);
	setText("api-error", view.error); $("api-error").hidden = !view.error;
	$("api-saved").hidden = !view.saved;
	$<HTMLButtonElement>("api-save").disabled = !view.canSave;
	$<HTMLButtonElement>("api-close").disabled = view.saving;
	for (const provider of view.providers) {
		setText(`api-${provider.id}-status`, provider.status);
		setText(`api-${provider.id}-label`, `${provider.name} ${view.copy.keyLabel}`);
		setText(`api-${provider.id}-link`, view.copy.official);
		setText(`api-${provider.id}-remove-label`, view.copy.remove);
		const input = $<HTMLInputElement>(`api-${provider.id}-key`);
		input.placeholder = view.copy.placeholder; input.disabled = view.saving;
		const show = $<HTMLButtonElement>(`api-${provider.id}-show`);
		show.disabled = view.saving; show.dataset.show = view.copy.show; show.dataset.hide = view.copy.hide;
		setText(show.id, input.type === "password" ? view.copy.show : view.copy.hide);
		show.setAttribute("aria-pressed", String(input.type === "text"));
		$<HTMLInputElement>(`api-${provider.id}-remove`).disabled = view.saving || !provider.canRemove;
	}
	if (view.open && !dialog.open) dialog.showModal();
	else if (!view.open && dialog.open) { dialog.close(); clearInputs(); }
}
export function setupApi(send: (intent: unknown) => Promise<boolean>): void {
	$("api-open").onclick = () => {
		$("settings-panel").hidePopover();
		void send({ type: "apiOpen" });
	};
	const close = () => { if (!$<HTMLButtonElement>("api-close").disabled) { clearInputs(); void send({ type: "apiClose" }); } };
	$("api-close").onclick = close;
	$<HTMLDialogElement>("api-dialog").oncancel = (event) => { event.preventDefault(); close(); };
	for (const card of Array.from(document.querySelectorAll<HTMLElement>(".api-provider"))) {
		const id = card.dataset.provider!;
		$("api-" + id + "-show").onclick = () => {
			const input = $<HTMLInputElement>(`api-${id}-key`);
			input.type = input.type === "password" ? "text" : "password";
			const button = $<HTMLButtonElement>(`api-${id}-show`);
			button.textContent = input.type === "password" ? button.dataset.show! : button.dataset.hide!;
			button.setAttribute("aria-pressed", String(input.type === "text"));
		};
		$("api-" + id + "-link").onclick = () => { void send({ type: "apiLink", provider: id }); };
	}
	$("api-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const providers = Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>(".api-provider")).map((card) => {
			const id = card.dataset.provider!;
			return [id, { key: $<HTMLInputElement>(`api-${id}-key`).value, remove: $<HTMLInputElement>(`api-${id}-remove`).checked }];
		}));
		void send({ type: "apiSave", providers });
	});
}
