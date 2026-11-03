import { createGame } from "/Users/szou/Python/Playground/DoorBird/Apps/blackjack/src/business/rules.ts";
import { turnSignals } from "/Users/szou/Python/Playground/DoorBird/Apps/blackjack/src/business/decision.ts";
import { loadConfig, piArgs } from "/Users/szou/Python/Playground/DoorBird/Apps/blackjack/src/agent/config.ts";
const app = "/Users/szou/Python/Playground/DoorBird/Apps/blackjack";
let state: any = createGame(() => 0.42);
let sig: any; try { sig = turnSignals(state); } catch (e) { console.log("turnSignals on fresh game threw:", String(e)); }
if (!sig) { state = { ...state, turn: { seat: "ai", phase: "betting" } }; sig = turnSignals(state); }
console.log("playbook:", sig.guidance?.playbook, "phase:", sig.phase);
const c = loadConfig(app, process.env);
const p = Bun.spawn([c.piBin, ...piArgs(c).map((a, i, all) => all[i - 1] === "--tools" ? "read,observe_table,evaluate_hand,commit_action" : a)], { cwd: app, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, BLACKJACK_TURN_SIGNALS: JSON.stringify(sig), PI_OFFLINE: "1" } });
p.stdin.write(JSON.stringify({ id: "1", type: "prompt", message: `/skill:blackjack-coach ${JSON.stringify(sig)}` }) + "\n"); p.stdin.flush();
const r = p.stdout.getReader(); let buf = ""; const end = Date.now() + 120000;
while (Date.now() < end) { const { value, done } = await r.read(); if (done) break; buf += new TextDecoder().decode(value); if (buf.includes('"agent_settled"')) break; }
p.kill();
for (const line of buf.split("\n").filter(Boolean)) { let e: any; try { e = JSON.parse(line); } catch { continue; }
  if (["message_update", "extension_ui_request"].includes(e.type)) continue;
  if (e.type === "message_end") { const m = e.message; console.log("MSG", m.role, m.stopReason ?? "", JSON.stringify((Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }]).map((x: any) => x.type === "text" ? { t: x.text?.slice(0, 300) } : x.type === "toolCall" ? { call: x.name, args: JSON.stringify(x.arguments).slice(0, 200) } : x.type)).slice(0, 600), m.errorMessage ?? ""); continue; }
  if (e.type === "tool_execution_end") { console.log("TOOL_END", e.toolName, e.isError, JSON.stringify(e.result?.content).slice(0, 300)); continue; }
  if (["response", "extension_error", "agent_settled", "agent_end"].includes(e.type)) console.log(e.type, JSON.stringify(e).slice(0, 300)); }
console.log("STDERR", (await new Response(p.stderr).text()).slice(-500));
