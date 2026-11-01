# Implementation plan

Stage 0 is implemented and verified. The app builds and opens a real Electron window over external Pi RPC. Offline tests execute the actual option-agent extension through fake-pi. The real Pi loader also passed a correlated no-model echo probe with zero model turns. Actual model generation and authentication were not verified. Stage 1 has not started. No market data or trading execution exists.

## Stage 0: Skeleton

**Goal**: Establish the four-layer Electron app over an external `pi --mode rpc` process, without Pi SDK dependencies.

**Success Criteria**: A window sends a prompt to Pi and shows its response and a hello tool call. Native option-coach skills and DTOs define the advice-only boundary. The default model is `openai-codex/gpt-6.1-sol`, with Anthropic routes rejected.

**Tests**: `bun run typecheck`, `bun test` with 130 passing tests across four files, `bun run build`, and `bun run test:smoke` with 16 passing checks on real Electron plus fake-pi. `bun run verify:pi` passed against the real Pi loader in an isolated credential-free environment. The probe checked five resources, a correlated handled echo and zero model turns. Artifacts are in `artifacts/electron-smoke.*`, `artifacts/pi-probe.log` and `artifacts/stage0-verification.log`. The root `just option-trading-agent` recipe also started Electron with fake-pi successfully.

**Status**: Complete

- [x] 0.1. Add package, strict TypeScript configuration, ignore rules, app and root just recipes, build script, lockfile, and this plan. The build now emits runnable main, preload, renderer, HTML and CSS files.
- [x] 0.2. Add external Pi config, bounded UTF-8 JSONL, correlated RPC, driver lifecycle, hello tool, budgets and model guards. Add the no-model Stage 0 echo command and explicit real-loader probe.
- [x] 0.3. Add business DTOs and discriminated operation, connection and tool states. Add the native option-coach entry skill and facts-over-heuristics and advice-not-orders principles.
- [x] 0.4. Add Electron main, sandboxed context-isolated preload, renderer and allowlisted IPC. Reject foreign windows and frames. Preserve unsent drafts across state updates, stop, restart and failure.
- [x] 0.5. Add offline fake-pi tests that execute the actual extension, architecture and skill checks, real Electron smoke, assertion and screenshot artifacts, Chinese README and initial decision log. Verify typecheck, tests, build, smoke and real Pi no-model echo before marking Complete. No actual model response or market access is claimed.

## Stage 1: Market data

**Goal**: Retrieve and cache Massive market data through one extension-owned service.

**Success Criteria**: Daily bars, filtered option chains, individual contracts, market holidays, and one-month Treasury rates use explicit ok, empty, partial, unavailable, and error results. Domain tools and desktop market tables share the service. Credentials never enter renderer data, logs, or cache.

**Tests**: Offline fixtures cover parsing, normalization, pagination, cache, missing fields, permissions, and credential boundaries. Run typecheck, offline tests, build, and Electron smoke. Run an explicit Massive probe with at most three HTTP calls and record only a secret-free summary.

**Status**: Not Started

## Stage 2: Technical analysis

**Goal**: Calculate technical signals from daily bars with pure functions.

**Success Criteria**: SMA, EMA, RSI, ATR, Bollinger bands, support and resistance, and 20-, 50-, and 200-day trends are available through `analyze_technicals`, the technical-analysis skill, and the desktop.

**Tests**: Deterministic indicator fixtures, short-history cases, tool results, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started

## Stage 3: Scenario grid

**Goal**: Calculate option-price scenarios across underlying moves and remaining trading days.

**Success Criteria**: Black-Scholes values use trading-day close times, implied volatility, and Treasury rates. `scenario_price_grid`, the set-limit playbook, and a desktop heatmap expose tick-rounded limit prices.

**Tests**: Pricing fixtures, holidays, early closes, time zones, expiry boundaries, and tick rounding. Run typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started

## Stage 4: Single-leg strategy screening

**Goal**: Support advice for STO, ROLL, and BTC on PUT and CALL positions.

**Success Criteria**: Strategy candidates expose evidence, assumptions, missing inputs, and risk without placing orders.

**Tests**: Fictional strategy fixtures for each action and option direction, missing-data cases, advice-only boundaries, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started

## Stage 5: Two-leg spreads

**Goal**: Evaluate two-leg spreads without general multi-leg execution.

**Success Criteria**: Spread advice identifies both legs, net premium, payoff bounds, and risk. No broker connection or order submission exists.

**Tests**: Fictional spread fixtures, leg validation, payoff boundaries, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started

## Stage 6: Portfolio management and reports

**Goal**: Track local cash, stock, and option positions with human-recorded trade progress.

**Success Criteria**: Local JSON supports advice, banker email, phone confirmation, and fill recording states plus monthly reconciliation. The app never submits orders.

**Tests**: Fictional portfolio fixtures, valid and invalid state transitions, reconciliation, persistence, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started

## Stage 7: Risk controls

**Goal**: Apply position limits, drawdown circuit breakers, and pre-trade discipline gates to advice.

**Success Criteria**: Breached limits and missing evidence block actionable recommendations with explicit reasons. Human execution remains outside the app.

**Tests**: Position-limit boundaries, drawdown trips and resets, discipline failures, missing-data cases, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started
