# 边牧任务桌面 · TillDone Desk

A standalone Electron UI driving Pi as a child process over RPC. Pi is not embedded, and `extensions/tilldone/` is unchanged.

Chinese name **边牧** (Border Collie); slogan *Don't stop until it's done* / **羊不进圈，边牧不歇**. Tasks are the sheep, the TillDone-equipped AI is the collie, the user is the shepherd. See `discussions/2026-10-29-tilldone-naming-border-collie.md` for the agreed metaphor.

## Run

From the repository root (Bun, just, a graphical desktop, and an authenticated Pi installation are required):

```sh
just tilldone-desk-install
just tilldone-desk
just tilldone-desk-test
```

Or from this directory: `just tilldone` installs dependencies, builds, and launches. Closing the window, Cmd+Q, or Ctrl+Q quits the app and stops the Pi child, and `just` returns to the shell. The plain scripts are `bun run build`, `bun run start`, `bun run test`. `bun run typecheck` checks TypeScript. `bun run test:smoke` builds and opens real Electron with the fake Pi; no provider is contacted.

The input sends a prompt while idle. During a run, select steer or follow-up; Stop clears queued messages before aborting. Enter sends; Shift+Enter inserts a newline. Tools are initially collapsed and remain expanded if opened during updates. `/tilldone` only focuses the local task panel, even during a run.

The interface defaults to **Simplified Chinese** and **system appearance**. The header's Settings (设置) button opens a compact popover with separate theme and language rows. Themes include 系统 / 浅色 / 深色 plus 素纸 / 星夜 / 水墨 / 霓虹; languages are 中文 / English. Four icon-and-label shortcuts immediately to the left of Settings switch to the featured skins in one click, with an active-state indicator. Click outside or press Escape to dismiss it. The always-visible task panel needs no separate toolbar button; `/tilldone` remains a focus shortcut. System mode follows OS appearance changes. Main-process preferences are saved in Electron's user-data directory as `appearance.json` and survive Pi and app restarts. Only interface labels are translated: assistant text, task names, extension confirmation titles/messages, Pi status text, and diagnostics remain verbatim.

### Pi API credentials

Open **Settings → API key settings** (设置 → API Key 设置) for DeepSeek and OpenAI. This is a front end for **Pi's own credential file**, not an independent desktop secret store:

- Default path: `~/.pi/agent/auth.json`. `PI_CODING_AGENT_DIR` selects the same alternate agent directory for both Pi and this UI; relative paths are resolved from Pi's working directory. The target path is displayed before saving.
- Existing keys are never sent back to the renderer. New input is masked with a keyboard-accessible show/hide button. Blank fields retain the corresponding credential; explicit removal deletes only that provider's entry. Cancelling clears drafts.
- Saving merges `{ "type": "api_key", "key": "..." }` into the selected provider entry. It preserves `openai-codex` OAuth credentials and all unrelated providers. Replacing/removing an `openai` OAuth credential is an explicit operation; the status label warns that saving a key replaces it.
- Pi-compatible `proper-lockfile` locking protects concurrent OAuth refreshes. The latest file is re-read under the lock, and a verified 0600 temporary file is renamed into place. Malformed files, symlinks, and lock failures fail closed rather than discarding existing credentials.
- **Pi stores API keys in plaintext in `auth.json`.** Do not share the file. This app does not claim encryption or create `.env`, a desktop-only credential file, or API-key environment overrides. The Pi child retains its normal authentication resolution.
- Metadata distinguishes Pi API keys, Pi OAuth, Pi command credentials, inherited environment keys, and missing credentials. Inspecting the UI never executes a stored `!command`, refreshes OAuth, or validates a key against a provider. Removal does not revoke the key at the provider and does not unset environment variables or remove `models.json` authentication.
- Official key-management links are fixed to the OpenAI and DeepSeek websites and open in the system browser through trusted IPC. Arbitrary renderer URLs/providers are rejected.

**Saving never switches models, restarts Pi, or submits a prompt.** DeepSeek/OpenAI API billing is separate from Codex/ChatGPT subscriptions. The default remains `openai-codex/gpt-6.1-sol`; to use a saved API key, select a known Pi model through `TILLDONE_MODEL=openai/<model-id>` or `TILLDONE_MODEL=deepseek/<model-id>` when launching. Pi can re-read shared credentials; restart the app if the current process still uses cached credentials. No actual balance, access, or model availability is verified by saving.

Thinking depth currently follows Pi's saved configuration and model capabilities, with its effective value shown in the footer. There is not yet a desktop thinking/model selector or first-run provider wizard. Pi's TUI `/model` and `/scoped-models` commands are not sent through RPC; a future desktop selector should use the corresponding RPC model commands.

### Branding

The visible product name, native window title, and slogan follow the selected language:

| Language | Product name | Slogan |
| --- | --- | --- |
| 中文 | 边牧任务桌面 | 交给边牧(AI牧羊犬)，安心放牧(任务必达) |
| English | TillDone Desk | Don't stop until it's done |

The header includes an original inline SVG AI border-collie logo: black-and-white collie markings, a circuit detail, and a check-mark collar chip. Its accents follow the theme, and its accessible label follows the language. It requires no external asset, image permission, network request, or additional dependency. Narrow windows allow the slogan to wrap without hiding it or crowding the theme shortcuts. Internal package/user-data names are unchanged so existing preferences remain available.

### Featured skins

The four skins adapt the actual palette and visual language of `mini-six-ren/src/web.css` and `src/themes/{night,ink,neon}.css`:

- **素纸 / Paper**: warm paper, cinnabar accents, soft serif headings.
- **星夜 / Night**: deep-blue star field, gold accents and subtle glow.
- **水墨 / Ink**: rice-paper white, ink lines, red seals, square corners and serif content.
- **霓虹 / Neon**: near-black terminal, cyan/magenta accents, grid and subtle scan lines.

Local `renderer/themes.css` maps these palettes onto Desk's semantic CSS tokens. CSS gradients replace the source project's SVG textures and animated canvas, so no image/network permission, canvas render loop, source-project dependency, or CSP relaxation is needed. The original project is not modified. Existing system/light/dark preferences stay compatible and the default remains system mode.

Skin changes use a 320ms fade plus paint-property transitions, without recreating messages, clearing drafts, or replaying effects on view updates. System reduced-motion preference disables both animation and transitions (and cancels an active fade). Preferences still travel as intents to the main process and survive app restarts; no renderer-side storage is introduced.

### Configuration

| Variable | Default |
| --- | --- |
| `TILLDONE_MODEL` | `openai-codex/gpt-6.1-sol` |
| `TILLDONE_PI_BIN` | `pi` from PATH |
| `TILLDONE_CWD` | Electron's startup `process.cwd()` |

**All `anthropic/*` models are rejected before window creation or child spawn**, with a billing explanation and nonzero exit. That API is metered and has no funded credit. The renderer cannot change models or submit arbitrary RPC commands.

The just recipe changes into `apps/tilldone`, matching the stock app's recipes. To work in the repository root instead:

```sh
TILLDONE_CWD="$PWD" just tilldone-desk
```

The working directory is displayed in the status bar. The extension path is resolved from `app.getAppPath()` to `../../extensions/tilldone`, never from the working directory or a baked-in absolute path. This is a source-tree app, not a packaged distribution.

The subprocess command is:

```text
pi --mode rpc --no-session --no-extensions --no-skills --model <model> -e <repo>/extensions/tilldone
```

Closing the app shuts down the child (stdin EOF, then bounded signal escalation if needed). A crash or exit shows an explicit warning and Restart button. Restart creates a **fresh, non-persisted Pi session**, losing the old conversation/task state; appearance preferences are retained. The app does not submit a prompt automatically. The header's **New session (新会话)** button does the same restart on demand: it is enabled only while Pi is connected and idle (Stop a run first), asks for confirmation, and then replaces the child with a fresh `--no-session` Pi, so the model starts with an empty context and an empty task list.

## Four layers

| Layer | Files | Responsibility |
| --- | --- | --- |
| L1 platform | Electron runtime and external Pi executable | Unmodified runtimes; no embedded Pi SDK |
| L2 glue | `src/main.ts`, `preload.ts`, `desk.ts`, `rpc.ts`, `jsonl.ts`, `config.ts`, `credentials.ts` | Own mutable state, subprocess, clock, preferences file, Pi auth-file adapter, ID correlation, IPC, and view delivery |
| L3 domain | `src/domain.ts`, `appearance.ts`, `api-domain.ts` | Pure `reduce(state, record)`, intent planning, task selection, localization, and `toViewModel(state)` |
| L4 render | `renderer/` | Paint JSON views and send intents; no RPC parsing, domain imports, business state, or local storage |

L3 imports no Node/Electron or L2/L4 code. Task snapshots use the existing extension's zero-dependency `parseDetails`; counts, current task and icons directly reuse **`countByStatus`, `current`, `STATUS_ICON`** from `extensions/tilldone/state.ts`. No duplicate task selectors are needed. Immutable domain values live only in L2's cell; local `desk_*` records supply transport and time facts. Appearance changes use the same pure transitions. The renderer has only DOM presentation state (draft, scroll position, open tool details), not a cached model.

## RPC details and limitations

- Task data comes **only** from `tool_execution_end` for `toolName === "tilldone"`, using its complete `result.details` snapshot, including empty lists. Execution-start arguments are retained by tool-call ID; execution-end arguments are not used.
- Assistant `text_delta` values accumulate by `contentIndex`; `text_end` and `message_end` replace partial content with authoritative content. Tool results and user/custom message lifecycles do not duplicate transcript entries.
- `agent_end` is not idle. The active-run latch clears at **`agent_settled`**, so automatic nudge continuations remain visibly running. `get_state` is queried initially, on lifecycle boundaries, and every two seconds for model, thinking level, streaming/compaction status. `tilldone-nudge` messages have a distinct style and label.
- Confirm responses echo the exact request ID and `confirmed` boolean. The main-process clock drives the displayed countdown. On timeout, the client **only closes the dialog**; Pi resolves its own timeout. Stale responses are ignored. `select`, `input`, and `editor` receive immediate `cancelled: true` responses.
- `setStatus` uses `statusKey` / `statusText` directly. No reliance on `setWidget`, `setFooter`, or `ui.custom()`; the current task is derived from details.
- Framing splits **only on LF**, strips a trailing CR, and uses a UTF-8 decoder across chunks. U+2028/U+2029 inside JSON strings remain intact. No Node `readline`. Stdin writes are serialized and wait for write callbacks; command responses are matched by ID with deadlines. Stderr is bounded diagnostic text, never parsed as RPC.
- This MVP renders plain text, not Markdown, images, or thinking content. It does not implement TUI-only commands, session restore, model selection, or unsupported extension editors/widgets.

## Security

Renderer sandbox and context isolation are enabled; Node integration is disabled. CSP permits only local scripts/styles and blocks network connections, images, frames, objects, and form navigation. All external text uses `textContent`. New windows, navigation, webviews, and permission requests are denied. IPC validates the owning webContents, exact main frame, and page URL for both intents and subscriptions. Preload exposes only `send(intent)` and `onView(callback)`; callbacks never receive Electron events. Intents are shape-checked in L3 and mapped to an allowlisted RPC subset or local credential effects. Credentials never enter domain state or view models. API links are selected from a fixed provider allowlist, not renderer URLs. Pi is launched without a shell.

This protects the renderer boundary, **not the host from Pi's tools**: Pi and its explicitly loaded extension have the current user's OS permissions in the displayed working directory. Review prompts and confirmation dialogs accordingly.

## Tests

`test/fixtures/rpc-probe.jsonl` is an exact copy of the supplied real recording. Offline Bun tests cover snapshot milestones, streaming text, confirm lifecycle, nudge/settled behavior, intent routing, appearance defaults/localization/system themes, framing (including split UTF-8 and Unicode separators), billing refusal, response reordering, errors/timeouts, crashes/start failures, restart, and a fake-Pi replay that blocks until the matching confirmation response arrives.

`test/fake-pi.ts` is executable and injected via `TILLDONE_PI_BIN`; it never invokes a model. The optional Electron smoke test checks the actual sandboxed window, narrow bridge, task-panel interception, collapsed tools, confirmation round trip, text injection safety, crash/restart UI, both languages, all seven themes, four one-click shortcuts, source palette values, minimum-width toolbar layout, draft preservation, no repeated animations or dropdown mutations on view updates, reduced motion, skin persistence across a full app restart, localized product names/slogans/native titles, and Chinese header layout in every featured skin at minimum window width. Its screenshots are written to the OS temporary directory.

`test/api.test.ts` covers the Pi auth schema/path, keep/replace/remove semantics, Codex and unrelated-provider preservation, concurrent refreshes under the same lock protocol, malformed files/symlinks/I/O errors, metadata-only views, and fake Pi reading the same auth file with no credential environment injection. `test/api-smoke.ts` additionally checks the real settings UI, official-link routing, cancellation/masking, validation, app restart, deletion, localization and all four skins. All credential tests use isolated temporary Pi directories and fake credentials; they never read or change the user's real auth file, execute stored key commands, or contact a real model/provider.
