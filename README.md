# SentinelX

**A self-critic autonomous trading agent.** Built for the **Bitget AI Base Camp Hackathon S2** —
*Agentic Trading* track, *Event-Driven Agent* direction.

> ## ⚠️ PAPER TRADING ONLY
> SentinelX v0.1 **cannot place a real order**. There is no exchange client, no API credential
> usage, no network call, and no code path that reaches a venue. Every fill is simulated locally
> with fees and slippage. `SENTINELX_MODE` only accepts `paper`; anything else throws
> `LIVE_TRADING_DISABLED` at startup.

---

## The idea

Most trading agents are optimists: they find a signal, size it, and fire. SentinelX is built
around a **deliberate internal argument**. Every cycle a proposal is generated, attacked, sized
under hard limits, executed on paper, then autopsied — and the lessons from that autopsy change
the agent's behaviour on the *next* cycle.

```
                     ┌────────────────────────────────────────────┐
                     │                                            │
   market data ──►  SCOUT  ──►  THESIS  ──►  ADVERSARY  ──►  RISK ──►  DECISION
   news / events    detect     propose     attack it      veto or    BUY/SELL/HOLD
                    events &   entry,      "why this      reduce        │
                    anomalies  stop,       loses"          size         ▼
                               target                            PAPER EXECUTION
                                                                      │
                     STRATEGY MEMORY  ◄──  TRADE AUTOPSY  ◄──  TRADE JOURNAL
                     lessons feed back      grade + mistake      append-only
                     into thesis,           tags                  audit trail
                     adversary and risk
```

The loop is closed: `Trade Autopsy` writes lessons into `Strategy Memory`, and `Strategy Memory`
is read by the Thesis Engine (confidence bias), the Adversary Agent (an extra objection), and the
Risk Engine. Run the demo twice and the second run is measurably more cautious about the patterns
that lost money in the first.

## Modules

| Module | File | Responsibility |
| --- | --- | --- |
| Scout Agent | `src/agents/ScoutAgent.ts` | Detects market-moving events and abnormal conditions (volume spike, price shock, volatility spike, spread widening, stale data). Emits a bias and an opportunity score. |
| Thesis Engine | `src/agents/ThesisEngine.ts` | Turns a scout report into a **falsifiable** thesis: direction, entry, stop, target, confidence, horizon, and an explicit invalidation condition. |
| Adversary Agent | `src/agents/AdversaryAgent.ts` | Red-teams the thesis with a checklist of objections, names the single most likely reason it loses (`killShot`), lists failure modes, and discounts confidence. Verdict: `SURVIVE` / `WEAKEN` / `REJECT`. |
| Risk Engine | `src/agents/RiskEngine.ts` | Fixed-fractional position sizing plus hard vetoes. Can `APPROVE`, `REDUCE`, or `VETO`. Owns the daily-loss circuit breaker. |
| Decision Engine | `src/agents/DecisionEngine.ts` | Final arbiter. Combines everything above into exactly one `BUY`, `SELL`, or `HOLD` with the reasoning attached. Never invents its own view. |
| Paper Execution | `src/execution/PaperBroker.ts` | Simulated fills with fee + slippage, position/stop/target/time management, equity accounting, circuit breaker. **No network access.** |
| Trade Journal | `src/journal/TradeJournal.ts` | Append-only JSONL audit trail: every cycle, decision, fill, close and autopsy. |
| Trade Autopsy | `src/autopsy/TradeAutopsy.ts` | Post-mortem of closed trades. Grades the *process* (A–F), tags mistakes, extracts a lesson. |
| Strategy Memory | `src/memory/StrategyMemory.ts` | Persists lessons to `.sentinelx/memory.json` and returns a bounded confidence adjustment for future setups. |

Supporting layers:

- `src/data/` — `MarketDataProvider` and `EventFeed` interfaces plus a deterministic
  `SimulatedWorld`. **This is the only place Bitget data needs to be wired in later.**
- `src/config/settings.ts` — typed settings with safe defaults and hard caps that env vars cannot
  loosen beyond `HARD_LIMITS`.
- `src/pipeline/TradingPipeline.ts` — orchestration of one full cycle.
- `src/cli.ts` + `src/cli/report.ts` — CLI entry point and console reporting.

## Quick start

Requires Node.js 18+ (developed on Node 20).

```bash
npm install && npm start
```

That compiles TypeScript and runs a 48-bar simulated session over `AAPL`, `NVDA`, `TSLA`, `MSFT`
with $10,000 of paper equity. The run is deterministic: the same seed always produces the same
market, the same events, and the same decisions.

### Useful variations

```bash
node dist/cli.js --cycles 120 --seed 7 --verbose   # longer session, full reasoning chain
node dist/cli.js --quiet                           # fills, closes and summary only
node dist/cli.js --symbols AAPL,NVDA --equity 5000   # narrow universe
node dist/cli.js review                            # replay stats from the journal
node dist/cli.js --reset                           # wipe journal + strategy memory first
node dist/cli.js help                              # all options
```

Sample output (trimmed):

```
  SCOUT   NVDA        3342.86  bar   +1.02%  opp  42%  bias LONG
          anomalies: PRICE_SHOCK
          events: NVDA: quarterly earnings beat expectations [EARNINGS 0.67]
  THESIS  LONG NVDA @ 3342.86  stop 3306.09  target 3423.76  conf 60.0%
          invalidated by: Price loses 3306.09 or the catalyst is contradicted...
  ADVERSARY verdict SURVIVE  conf 60.0% -> 60.0%  objections 0
          kill shot: Nothing concrete enough to block it - but this thesis has no buffer...
  RISK    REDUCE qty 0.300924 notional $1005.95 risk $11.07 stop +1.10% limits: MAX_POSITION_PCT
          Risking $11.07 (0.50% of equity) with a 1.10% stop.
  DECISION BUY  NVDA   qty 0.300924 @ 3342.86
  FILL    BUY  0.300924 NVDA @ 3345.68 (fee $0.60) [PAPER]
  CLOSED  NVDA   TARGET_HIT   entry 3345.68 exit 3423.76 pnl $22.83 (+2.27%)
  AUTOPSY NVDA grade A  $22.83 (+2.27%)  exit TARGET_HIT
          lesson: Clean target hit on NVDA for $22.83 - repeat this setup: ...
```

## Risk controls (safe defaults)

| Control | Default | Hard cap |
| --- | --- | --- |
| Risk per trade (% of equity, entry→stop) | 0.5% | 5% |
| Max position (% of equity) | 10% | 25% |
| Max open positions | 3 | — |
| Max leverage | 1x | 1x (cannot be raised) |
| Daily loss circuit breaker | 3% → halt | 20% |
| Min confidence after adversary | 0.50 | — |
| Max chase (single-bar move) | 6% | — |
| Max spread | 0.35% | — |
| Max holding time | 240 min | — |
| Re-entry cooldown per symbol | 30 min | — |
| Long-only | yes | shorts/leverage not implemented |

Additional refusals: no pyramiding into an existing position, no churning back into a symbol
straight after a close, no trade below a $10 notional, no trade when data is non-finite or stale,
and no live order path at all.

Configure via `.env` (see `.env.example`). Values above a hard cap are silently clamped down, and
`SENTINELX_MODE=live` fails fast.

## Tests

Built-in `node:test` only — **no external test dependencies**.

```bash
npm test
```

That compiles `src/` and `test/` into `dist-test/` and runs the suite. Tests drive the agents
through a scripted `FakeDataLayer` (`test/helpers.ts`) rather than the randomised mock world, so
they are deterministic and seed-independent, and they write to a throwaway directory under
`os.tmpdir()` — never to the repo's `.sentinelx/`.

| Test file | Guarantees |
| --- | --- |
| `test/paperOnly.test.ts` | `paper` is the only mode; `SENTINELX_MODE=live/real/prod/demo/margin` throws `LIVE_TRADING_DISABLED`; the `SENTINELX_ALLOW_LIVE` escape hatch throws before any order is simulated; the default data layer is simulated; no source file performs network I/O; `package.json` has zero runtime dependencies; `.env.example` ships with empty credential fields. |
| `test/riskEngine.test.ts` | Fixed-fractional sizing, the position cap (`REDUCE`), adversary-driven size halving, and vetoes for low confidence, adversary rejection, an active circuit breaker, max open positions, pyramiding, re-entry cooldown, wide spread, extended move, invalid stop and sub-minimum notional. |
| `test/tradeLifecycle.test.ts` | A valid setup survives Scout → Thesis → Adversary → Risk and becomes a paper fill; the journal persists `CYCLE`, `DECISION`, `FILL` and `TRADE_CLOSED` lines as parseable JSONL; a take-profit close is graded by the autopsy and its lesson is stored, persisted and reloaded by `StrategyMemory`; a stop-out produces a negative lesson that lowers confidence for the same pattern; a risk veto keeps the account flat and is journalled as `HOLD`. |

Run a single file:

```bash
npm run build:test && node --test dist-test/test/riskEngine.test.js
```

## Connecting Bitget data later

Nothing in the agent layer knows where data comes from. To go from mock to real:

1. Implement `MarketDataProvider` (`src/data/MarketDataProvider.ts`) against Bitget's public
   market endpoints and return `MarketSnapshot`.
2. Implement `EventFeed` (`src/data/EventFeed.ts`) against Bitget announcements / your news source
   and return `NewsEvent[]`.
3. Register them in `createDataLayer()` (`src/data/index.ts`).

No agent, broker, journal, autopsy or memory code changes. Credentials are read from `.env` and
**ignored** in v0.1 — the CLI prints a notice and keeps running fully simulated.

## Persistence

Written under `.sentinelx/` (gitignored):

- `journal.jsonl` — one JSON object per line; the complete reasoning and execution audit trail.
- `memory.json` — accumulated lessons, keyed by mistake tag and symbol, with occurrence counts.

`--reset` deletes both.

## Project layout

```
sentinelx/
├── src/
│   ├── cli.ts                    # CLI entry point
│   ├── cli/report.ts             # console formatting
│   ├── config/{env,settings}.ts  # dependency-free .env loading, safe defaults + hard caps
│   ├── types/index.ts            # all domain types
│   ├── data/                     # provider interfaces + deterministic simulated world
│   ├── agents/                   # Scout, Thesis, Adversary, Risk, Decision
│   ├── execution/PaperBroker.ts  # simulated fills, stops, targets, circuit breaker
│   ├── journal/TradeJournal.ts   # append-only audit trail
│   ├── autopsy/TradeAutopsy.ts   # grading + mistake tagging
│   ├── memory/StrategyMemory.ts  # lessons that feed back into decisions
│   ├── pipeline/TradingPipeline.ts
│   └── util/index.ts             # seeded RNG, ids, formatting, error type
├── test/
│   ├── helpers.ts                # fixtures + a scripted FakeDataLayer (no network)
│   ├── paperOnly.test.ts         # paper-only guarantees
│   ├── riskEngine.test.ts        # vetoes, sizing and limit behaviour
│   └── tradeLifecycle.test.ts    # pipeline -> broker -> journal -> autopsy -> memory
├── .env.example
├── package.json
├── tsconfig.json
└── tsconfig.test.json
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Build then run the default demo session |
| `npm run demo` | Build then run 24 cycles |
| `npm test` | Compile `src/` + `test/` to `dist-test/` and run the `node:test` suite |
| `npm run build:test` | Compile the test build only |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run clean` | Remove `dist/` |

## Verified Paper-Trading Benchmark

A deterministic 24-hour paper-trading run using seed `1337` produced:

| Metric | Result |
|---|---:|
| Starting equity | $10,000.00 |
| Ending equity | **$10,078.15** |
| Total return | **+0.78%** |
| Realized P&L | **+$78.15** |
| Closed trades | **36** |
| Win rate | **50.0%** |
| Winning trades | 18 |
| Losing trades | 18 |

This benchmark is fully simulated and paper-only. No live orders or exchange credentials are used.

## Roadmap

- [ ] Bitget market data provider (tickers, depth, quotes, and market events)
- [ ] Bitget announcement / news event feed with sentiment classification
- [ ] LLM-backed Thesis and Adversary reasoning behind the current rule-based engine
- [ ] Walk-forward evaluation harness over recorded market data
- [ ] Position management: partial exits, trailing stops, breakeven moves
- [ ] Multi-timeframe scouting and cross-symbol correlation checks
- [ ] Optional live mode behind explicit credentials, allowlists and human confirmation

## Disclaimer

Educational hackathon software. Nothing here is financial advice. It has never been connected to a
live account and must not be pointed at one without an independent, audited risk review.

---

**Built by RonyZ**
