The analysis of how to refactor the business layer (layer 3) of the five-llm app (in aicoder2048/pi-vs-claude-code, path apps/five-llm) into a pstack-style plugin of skills. This is a follow-up to the pstack rundown I sent earlier. Sean wants this as reference for designing business-layer skills for his projects, starting with five-llm as a case study, and later the Chinese chess agent harness.

CURRENT STATE OF five-llm:
- It's a Gomoku (five-in-a-row) game with an LLM agent playing via the Pi SDK.
- Four-layer architecture: agent layer (src/agent/pi-driver.ts: Pi SDK session, model auth, request budget, cancel/timeout), business layer (src/business/: engine.ts for rule calculations/win checks/position evaluation, clock.ts for authoritative clock with Japanese byoyomi overtime, game-service.ts for game flow/multi-game scoring/version validation), Electron layer (src/electron/: IPC, persistence), renderer layer (src/renderer/: Canvas board UI, Web Audio).
- src/extensions/gomoku.ts is a Pi extension registering three tools: analyze_position, simulate_moves, place_stone, plus turn-port injection.
- Root RULES.md documents match conventions, timing rules, references.
- src/shared/types.ts has cross-layer DTOs (IPC messages, state snapshots, game record format).
- tests/ covers rule validation, clock edge cases, Pi integration (tool dispatch, illegal move correction), Electron smoke tests.
- Problem: rules, decision signals, and domain knowledge are all crammed into engine.ts. No skillization, no principles layer, no playbooks. The LLM only touches business through those three coarse tools, with no structured "how to play" guidance in context.

PROPOSAL — REFACTOR BUSINESS LAYER INTO A PSTACK-STYLE SKILL PACK:

1. UPGRADE RULES.md INTO A PRINCIPLES LAYER. pstack has 24 one-sentence principle skills. five-llm equivalents: principle-no-illegal-move, principle-block-threats-first, principle-open-threes, principle-double-three-forbidden. Each is an independent SKILL.md; the agent reads the index at startup instead of loading everything. RULES.md is currently human-readable; convert it to agent-readable.

2. SPLIT engine.ts INTO SKILLS PLUS TOOLS. Win checking, live-three/live-four recognition, ban detection each become a skill: skill-check-win, skill-evaluate-threats, skill-ban-check. The skill defines when and how to use it; the actual computation stays in TypeScript functions exposed via gomoku.ts tools. Same pattern as pstack's interrogate: skill is the instruction, subagent/tool is the executor.

3. TURN game-service.ts FLOW LOGIC INTO PLAYBOOKS. pstack's poteto-mode selects a playbook and copies steps verbatim. five-llm playbooks: playbook-opening (opening strategy), playbook-midgame (midgame attack/defense), playbook-endgame (endgame finishing), playbook-timeout (decision-making under time pressure). Each playbook is a markdown step list; game-service reads and injects it into context before/after LLM moves, skipped steps stay with a reason, same as pstack's todo list.

4. clock.ts STAYS INFRASTRUCTURE (like pstack's rules config files) but extract a time-strategy principle, e.g. principle-spend-time-on-critical-positions, so the agent knows when to think deeply during byoyomi.

5. ADD A VERIFICATION SKILL. pstack's create-verification-skill generates a project-local verify skill teaching the agent to operate like a user. five-llm gets skill-verify-board: after placing a stone, the agent self-checks with analyze_position and simulate_moves for missed bans and better open-fours. This is pstack's "prove it works" principle applied to Gomoku.

6. ADD SUBAGENTS. five-llm currently has none. Add a review-agent: after the LLM proposes a move, spawn a read-only subagent using interrogate-style multi-model cross-checking. Or a simulate-agent for parallel candidate-move exploration. pstack's arena skill does this.

COUPLING MECHANISM: pstack uses a shared todo-list file plus an always-applied rules file. five-llm already has shared/types.ts state snapshots; extend with a .five-llm/state directory of JSON files for playbook progress, principles index, and model assignments. game-service is the sole writer, same idea as pstack's pstack-models.mdc.

TOOL GRANULARITY: The three gomoku.ts tools are too coarse. Split analyze_position into evaluate_threats and check_bans; keep simulate_moves; add a validate_before_place pre-hook on place_stone (Purpose Gate idea: principles check before committing a move).

Sean will use this alongside the earlier pstack analysis when SpecWriter designs the business-layer skills, first for five-llm as a case study, then for the Chinese chess harness. Let me know if you want me to expand any section.
