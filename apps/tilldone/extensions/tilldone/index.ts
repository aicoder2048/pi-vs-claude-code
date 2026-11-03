/**
 * TillDone L2: glue. Owns the single mutable cell and translates Pi events
 * into L3 transitions and L4 paints. No business rule and no model-facing
 * string lives here.
 *
 * Usage: pi -e extensions/tilldone
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { applyExtensionDefaults } from "../themeMap.ts";
import { agentEnd, billingGate, gate, INITIAL_MODEL, type Model, type Roles, restore, runTool, TOOL, toolCalled, userInput } from "./state.ts";
import { paint, renderCall, renderResult, showList } from "./ui.ts";

const Params = Type.Object({
	action: StringEnum(TOOL.actions),
	text: Type.Optional(Type.String({ description: TOOL.params.text })),
	texts: Type.Optional(Type.Array(Type.String(), { description: TOOL.params.texts })),
	description: Type.Optional(Type.String({ description: TOOL.params.description })),
	id: Type.Optional(Type.Number({ description: TOOL.params.id })),
});

// pstack keeps its role-to-model map in <agent dir>/pstack/models.json; the agent dir follows Pi's own rule.
async function pstackRoles(cwd: string): Promise<Roles> {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const agentDir = configured ? resolve(cwd, configured.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), ".pi", "agent");
	try {
		const parsed = JSON.parse(await readFile(join(agentDir, "pstack", "models.json"), "utf8")) as { roles?: unknown };
		return parsed.roles && typeof parsed.roles === "object" ? (parsed.roles as Roles) : {};
	} catch {
		return {}; // No config means every role inherits the session model, which the desk already checked.
	}
}

// themeMap keys the theme on the basename of this URL. The file's own URL would
// give "index"; the directory URL gives "tilldone", like the original file.
const THEME_KEY_URL = new URL(".", import.meta.url).href;

export default function (pi: ExtensionAPI) {
	let model: Model = INITIAL_MODEL;
	// Split hints decided at tool_call, keyed by call id, appended when that call's result comes back.
	const hints = new Map<string, string>();

	const set = (next: Model, ctx?: ExtensionContext): void => {
		model = next;
		if (ctx) paint(ctx.ui, next.list);
	};

	const restoreFrom = (ctx: ExtensionContext): void => {
		const details: unknown[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "toolResult" && msg.toolName === TOOL.name && msg.details) details.push(msg.details);
		}
		set(restore(model, details), ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(THEME_KEY_URL, ctx);
		restoreFrom(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => restoreFrom(ctx));

	pi.on("tool_call", async (event, ctx) => {
		// Billing first: a hard rule that holds even when the discipline gate would let the call through.
		const roles = event.toolName === "subagent" ? await pstackRoles(ctx.cwd) : {};
		const billing = billingGate(event.toolName, event.input, roles);
		if (billing.block) return billing;
		const verdict = gate(model, event.toolName);
		if (verdict.block) return verdict;
		const counted = toolCalled(model, event.toolName);
		set(counted.model);
		if (counted.hint) hints.set(event.toolCallId, counted.hint);
		return verdict;
	});

	pi.on("tool_result", async (event) => {
		const hint = hints.get(event.toolCallId);
		if (!hint) return;
		hints.delete(event.toolCallId);
		return { content: [...event.content, { type: "text" as const, text: hint }], structuredContent: event.structuredContent };
	});

	pi.on("agent_end", async () => {
		const { model: next, nudge } = agentEnd(model);
		set(next);
		if (nudge) pi.sendMessage(nudge, { triggerTurn: true });
	});

	pi.on("input", async () => {
		set(userInput(model));
		return { action: "continue" as const };
	});

	pi.registerTool({
		name: TOOL.name,
		label: TOOL.label,
		description: TOOL.description,
		parameters: Params,
		// B3: the gate for the next call in a batch must see this call's result.
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const first = runTool(model, params);
			const reply =
				first.kind === "ask" ? runTool(model, params, await ctx.ui.confirm(first.title, first.message, { timeout: first.timeoutMs })) : first;
			if (reply.next) set(reply.next, ctx);
			return { content: [{ type: "text" as const, text: reply.text }], details: reply.details };
		},

		renderCall,
		renderResult,
	});

	pi.registerCommand(TOOL.name, {
		description: TOOL.commandDescription,
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tilldone requires interactive mode", "error");
				return;
			}
			await showList(ctx.ui, model.list);
		},
	});
}
