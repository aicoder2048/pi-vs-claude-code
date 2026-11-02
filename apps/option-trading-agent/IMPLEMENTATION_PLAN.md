# Implementation plan

Stage 0 and Stage 1 are Complete. All required gates passed, including Chinese market tables, 528 offline tests, 26 real Electron smoke checks, a real Pi zero-model loader probe, and one three-request Massive probe. Stage 2 through Stage 7 are Not Started. No broker connection, account access, or trade execution exists.

## Standing requirements

- Use four layers over external `pi --mode rpc`. Do not embed a Pi SDK or add an HTTP broker. The extension owns one market service shared by commands and tools.
- Default to `openai-codex/gpt-6.1-sol`. Reject Anthropic model paths, enforce exact resolved-model identity, and never silently substitute a model.
- Default the desktop to Simplified Chinese, `lang="zh-CN"`, and title `期权交易助理`. Keep PUT, CALL, IV, Greeks, OI, identifiers, model names, and raw diagnostics unchanged.
- Start without a model prompt or market request. Keep one active operation, typed `AgentView` and `MarketPanel`, local display filters, separate drafts, and stable market DOM during unrelated streaming updates.
- Read market credentials only from the canonical file. Ignore ambient `POLYGON_API_KEY`. Keep credentials out of renderer, RPC, cache, diagnostics, and repository.
- Distinguish missing values, empty results, incomplete results, unavailable data, and errors. Preserve provenance, data times, and fetch times separately. Advice is not execution. Native skills do not grant permissions.

## Stage 0: Skeleton

**Goal**: Establish an Electron advice desktop over external Pi RPC without Pi SDK dependencies.

**Success Criteria**: A real window sends a prompt and projects replies and actual hello events. Native skills, typed DTOs, allowlisted IPC, lifecycle cleanup, model guards, and tool budgets define the boundaries.

**Tests**: Offline RPC, extension, desktop, architecture, and skill checks. Real Electron with explicit fake-pi. Real Pi loader verification checks resources, model metadata, and a correlated handled echo with zero model turns. This does not prove authentication or genuine model behavior.

**Status**: Complete

- [x] 0.1. Package, strict TypeScript, build, lockfile, ignore rules, and just recipes.
- [x] 0.2. External Pi configuration, bounded UTF-8 JSONL, correlated RPC, lifecycle, hello, guards, and no-model echo.
- [x] 0.3. Business DTOs, state unions, option-coach, and two native principles.
- [x] 0.4. Sandboxed renderer, narrow preload, owner-window and main-frame IPC checks, and draft preservation.
- [x] 0.5. Offline tests, real Electron smoke, real Pi no-model verification, documentation, and decision trail.

## Stage 1: Market data

**Goal**: Retrieve and cache Massive data through one extension-owned service used by desktop commands and model tools.

**Success Criteria**: Daily bars, bounded option chains, contracts, market holidays, and one-month Treasury rates have explicit `ok`, `empty`, `partial`, `unavailable`, and `error` results. Chinese desktop tables load without a model turn. Data access may use Node within L3, while normalization stays pure. Credentials come only from the canonical file. Independent review fixes and final acceptance are complete; a successful probe alone was not treated as acceptance.

**Tests**: Offline normalization, identities, missing fields, pagination, limits, cache, permissions, credential boundaries, RPC correlation, and probe opt-in tests. Run `bun run typecheck`, `bun test`, `bun run build`, and both real Electron plus fake-pi smoke suites. Existing smoke artifacts record 26 passing checks, including Chinese defaults and unchanged-market DOM stability. The single parent-run live probe succeeded with exactly three HTTP attempts. Real holidays and Treasury endpoints remain unverified.

**Status**: Complete

- [x] 1.1. Market DTOs, validated queries and OCC parsing, pure normalizers, units, identities, and timestamp semantics.
- [x] 1.2. Injectable `MarketData`, canonical-file credentials, bounded HTTP, safe pagination, cancellation and query sharing, plus validated atomic cache with endpoint TTLs and a 128-entry limit.
- [x] 1.3. Lazy extension-owned service, three sequential market tools, correlated no-model market and contract commands, strict wire decoding, driver methods, and New York date plus loaded-symbol prompt context. Daily tool text retains all returned bars up to 500. Chain text shows at most 10 rows with omission counts and narrowing guidance.
- [x] 1.4. Allowlisted market IPC, Chinese daily and option tables, local single-expiry and PUT/CALL display filters, explicit counts and provenance, stable market DOM, busy-state controls, and lifecycle tests. Both smoke suites retain 16 desktop and 10 market checks.
- [x] 1.5. Manual-only `scripts/probe-massive.ts`, 31 offline probe tests, exact `--run` opt-in, isolated fresh cache, no retries, at most three actual HTTP attempts and one page per query, and normalized secret-free artifacts. Parent ran the probe once at `2026-11-02T00:32:19.767Z`. Results were 20 AAPL daily bars, six chain rows for `2026-11-06`, and one `O:AAPL261106C00342500` contract. All three were `ok`, with zero recorded missing desired fields. The November 2 fetch does not make the October 30 quotes live or fresh.
- [x] 1.6. Complete Chinese documentation, independent review, regression fixes, and final acceptance. Safe sibling skill reads now rewrite authorized canonical paths. PUT/CALL requests carry an optional provider-side filter through cache and RPC identity. Impossible future quote times are partial and rejected by the DTO boundary. The real-loader probe rejects fake-pi paths. Final typecheck, 528 offline tests across nine files, build, 16 desktop checks, 10 market checks, and isolated real Pi echo passed. The live Massive probe was not repeated. Evidence is in `artifacts/final-verification.log`, `artifacts/final-pi-probe.log`, `artifacts/massive-probe.json`, and `docs/decisions.tsv`.

## Stage 2: Technical analysis

**Goal**: Calculate technical signals from daily bars with pure functions.

**Success Criteria**: SMA, EMA, RSI, ATR, Bollinger bands, support and resistance, and 20-, 50-, and 200-day trends are available through `analyze_technicals`, the technical-analysis skill, and the desktop.

**Tests**: Deterministic indicator fixtures, short-history cases, tool results, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started

## Stage 3: Scenario grid

**Goal**: Calculate option-price scenarios across underlying moves and remaining trading days.

**Success Criteria**: Black-Scholes values use trading-day close times, implied volatility, and Treasury rates. `scenario_price_grid`, the set-limit playbook, and a desktop heatmap expose tick-rounded limit prices.

**Tests**: Pricing fixtures, holidays, early closes, time zones, expiry boundaries, tick rounding, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started

## Stage 4: Single-leg strategy screening

**Goal**: Support advice for STO, ROLL, and BTC on PUT and CALL positions.

**Success Criteria**: Candidates expose evidence, assumptions, missing inputs, and risk without placing orders.

**Tests**: Fictional fixtures for each action and option direction, missing-data cases, advice-only boundaries, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started

## Stage 5: Two-leg spreads

**Goal**: Evaluate two-leg spreads without general multi-leg execution.

**Success Criteria**: Advice identifies both legs, net premium, payoff bounds, and risk. No broker connection or order submission exists.

**Tests**: Fictional spread fixtures, leg validation, payoff boundaries, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started

## Stage 6: Portfolio management and reports

**Goal**: Track local cash, stock, and option positions with human-recorded trade progress.

**Success Criteria**: Local JSON supports advice, banker email, phone confirmation, fill recording, and monthly reconciliation. The app never submits orders.

**Tests**: Fictional portfolio fixtures, valid and invalid state transitions, reconciliation, persistence, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started

## Stage 7: Risk controls

**Goal**: Apply position limits, drawdown circuit breakers, and pre-trade discipline gates to advice.

**Success Criteria**: Breached limits and missing evidence block actionable recommendations with explicit reasons. Human execution remains outside the app.

**Tests**: Limit boundaries, drawdown trips and resets, discipline failures, missing-data cases, typecheck, offline tests, build, and Electron smoke.

**Status**: Not Started
