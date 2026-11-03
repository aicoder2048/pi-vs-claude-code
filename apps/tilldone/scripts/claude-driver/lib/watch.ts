/**
 * Claude driver: what to do on each look at the desk. Pure, so the policy is testable without Electron.
 *
 * Policy, unchanged from the 2026-11-01 Blackjack runs:
 * - An open confirm dialog is denied: nobody is there to approve, and denying is the safe answer.
 * - An open ask dialog (select / input / editor) is cancelled: the driver has no answer to give.
 * - A desk alert ends the run.
 * - The run is settled once the desk has been idle (Stop disabled) for the idle window.
 * - The deadline ends the run whatever the desk is doing.
 */

/** What the driver reads from the desk on one look. Dialog fields are null when the dialog is closed. */
export interface Snapshot {
	confirm: string | null;
	ask: string | null;
	alert: string | null;
	running: boolean;
	tasks: string;
}

export interface WatchState {
	idleSince: number | null;
	lastTasks: string;
	deniedConfirms: string[];
	cancelledAsks: string[];
	taskChanges: number;
}

export type Action = "deny-confirm" | "cancel-ask";
export type Outcome = { kind: "settled" | "alert" | "deadline"; detail: string };

export interface Step {
	state: WatchState;
	actions: Action[];
	logs: string[];
	outcome?: Outcome;
}

export const initialWatch = (): WatchState => ({ idleSince: null, lastTasks: "", deniedConfirms: [], cancelledAsks: [], taskChanges: 0 });

/** Task panel text on one line, as it appears in the log. */
export const oneLine = (text: string): string => text.replace(/\n+/g, " | ").trim();

export function step(state: WatchState, snap: Snapshot, now: number, limits: { idleMs: number; deadline: number }): Step {
	const next: WatchState = { ...state, deniedConfirms: [...state.deniedConfirms], cancelledAsks: [...state.cancelledAsks] };
	const actions: Action[] = [];
	const logs: string[] = [];
	if (snap.confirm !== null) {
		actions.push("deny-confirm");
		next.deniedConfirms.push(snap.confirm);
		logs.push(`CONFIRM DENIED: ${snap.confirm}`);
	}
	if (snap.ask !== null) {
		actions.push("cancel-ask");
		next.cancelledAsks.push(snap.ask);
		logs.push(`ASK CANCELLED: ${snap.ask}`);
	}
	const tasks = oneLine(snap.tasks);
	if (tasks !== state.lastTasks) {
		next.lastTasks = tasks;
		next.taskChanges++;
		logs.push(`tasks: ${tasks.slice(0, 1200)}`);
	}
	if (snap.alert !== null) {
		logs.push(`ALERT: ${snap.alert}`);
		return { state: next, actions, logs, outcome: { kind: "alert", detail: snap.alert } };
	}
	// A dialog the driver just answered means the run is still going, whatever Stop says.
	if (snap.running || actions.length) next.idleSince = null;
	else if (next.idleSince === null) next.idleSince = now;
	else if (now - next.idleSince >= limits.idleMs) {
		logs.push("idle — run settled");
		return { state: next, actions, logs, outcome: { kind: "settled", detail: `idle for ${Math.round((now - next.idleSince) / 1000)} s` } };
	}
	if (now >= limits.deadline) {
		logs.push("DEADLINE reached");
		return { state: next, actions, logs, outcome: { kind: "deadline", detail: "time limit reached while the desk was still busy" } };
	}
	return { state: next, actions, logs };
}

export const EXIT_CODE: Record<Outcome["kind"] | "error", number> = { settled: 0, error: 1, alert: 2, deadline: 3 };
