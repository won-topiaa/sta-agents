# STA Agents — your own investing agent for tokenized stocks on BNB Chain

**Give an AI agent your investing style. Code holds it to that style, backtests every idea, and trades only what you approve — or what Binance's limits allow.**

STA Agents is built for the BNB Hack: Tokenized Stocks Edition. It runs on BNB Smart Chain mainnet with Ondo and bStock tokenized stocks, through the Binance Web3 API and the Binance Agentic Wallet.

> Live app: _to be added_ · Demo video (≤ 4 min): _to be added_ · Mainnet transactions: _to be added_

---

## Why

AI trading agents arrived in 2026: you name an agent, fund a dedicated account and tell it what to do in chat. But an investing *style* that lives in chat drifts. You re-explain it every time, and nothing checks that a strategy actually followed it.

STA Agents makes the style a saved, versioned setting that the system enforces:

| | Typical chat agent | STA Agents |
| --- | --- | --- |
| Investing style | Re-stated in each prompt | Saved profile: **technical** (trend, dip, breakout) or **value** (deep value, quality, growth at a reasonable price), with rules and risk limits |
| Who enforces the rules | The model, hopefully | **Code** merges the agent's rules into every strategy before testing and checks them on the tested strategy |
| Evidence before money | The model's reasoning | Deterministic backtests: training/held-out split, doubled costs, future-data perturbation, parameter stability |
| Autonomy | On/off | Per agent: **approve every trade** (default) or **trade on its own within limits** in a Binance Agentic Wallet, where Binance enforces the daily limit |

## How it works

```text
Agent profile ─ style · rules · risk limits · rebalance · approval mode   (versioned; research binds to a version)
      │
"$30 in chip stocks, 5% over a year"
      │
Qwen3 32B (Kiln) ─ reads the request; designs 1–3 strategies in a typed strategy language (no code, no prices seen)
      │
Code ─ adds the agent's rules to every design · rejects designs that break the agent's style
      │
Isolated backtests ─ BSC-tradable universe · point-in-time prices and company fundamentals
      │             training-only selection · held-out horizons · doubled costs · future-data check
      ▼
Report ─ "3 of 3 agent rules kept" per strategy · eligible or declined, with reasons
      │
Owner approves an exact plan (legs in USDT; legs under the 5 USDT minimum stay in cash)
      │
      ├─ Approve every trade ─ Binance Trading API quote → exact-amount USDT approval → swap
      │                        → transaction checks → Transaction API dry run → wallet signs → receipt
      │
      └─ Trade within limits ─ Binance Agentic Wallet market orders, one leg at a time,
                               within the daily limit and token scope set in the Binance app
```

## Binance Web3 API and Agentic Wallet usage

All Binance calls go through one small service, the **BNB gateway** (`engine/bnb-gateway/server.mjs`). It holds the API key and the Agentic Wallet session and exposes a narrow, token-authenticated API to the app. It runs in a region where the Web3 API is available; the app servers never call Binance directly.

| Module | Calls | Used for |
| --- | --- | --- |
| RWA Data | `GET /api/v1/dex/market/rwa/platforms`, `/rwa/tokens` | Ondo and bStock tokens on BSC, underlying ticker, token-to-share ratio, market status (no order is prepared for a token that is not `TRADING`), token prices where no DEX pool is indexed |
| Trading | `GET /api/v1/dex/aggregator/quote`, `/aggregator/swap`, `/aggregator/approve-transaction` | Route and price (shown even when the wallet cannot pay yet), unsigned swap transaction, exact-amount approval of the router |
| Transaction | `POST /api/v1/dex/pre-transaction/simulate`, `GET /post-transaction/transaction-detail-by-txhash` | Dry run before any signature; indexed status after sending |
| Wallet | `GET /api/v1/dex/balance/all-token-balances-by-address` | Holdings view |
| Agentic Wallet (`@binance/agentic-wallet`) | `auth signin/verify`, `wallet address/settings/left-quota`, `market-order swap/list` | QR sign-in from the agent card; the limits Binance enforces; autonomous legs |

## Safety boundaries

**The model**
- It proposes designs only: typed data, size-limited, no code, no tools, no signing.
- It never sees price history, so it cannot fit a design to the backtest.
- An agent's free-text philosophy becomes *suggested* rules from a fixed catalog. Each suggestion must quote the owner's words, and the owner decides whether to add it.

**Agent rules**
- Rules are merged into every candidate by code.
- A technical agent cannot use company fundamentals; a value agent must score at least one.
- Compliance is checked on the exact design that was backtested, and approval requires every rule to show as kept.
- Editing the agent invalidates earlier results.

**Per-trade execution**, checked before the wallet is asked to sign:
- The approval is for the exact amount only, never unlimited.
- The swap's target is the documented router, `from` is the owner, `value` is 0, and the selector is known.
- Calldata contains the approved tokens and exact amount, and the minimum received is within slippage.
- The dry run succeeds.
- BNB for gas and the USDT balance are checked first.
- After the wallet sends, the on-chain transaction must be byte-identical to the prepared one.
- If the wallet's nonce moved after preparation, the same leg is never rebuilt, so it cannot be bought twice.

**Autonomous execution**
- Only plans of agents set to "trade on its own within limits" can start; the server checks the agent's *current* setting.
- Binance enforces the daily USD limit and token scope.
- Each leg is marked durably before its order is placed, and is never resubmitted after an interruption: it becomes "needs a check" instead.

## Company fundamentals for value agents

Value signals come from **SEC EDGAR XBRL company facts** (`engine/agent/xtxc_agent/research/fundamentals.py`). Each number is usable only from the session after its filing date, so a backtest on day *t* sees what had been published by then.

| Signal | Definition |
| --- | --- |
| earnings yield | TTM net income / market value |
| book-to-price | Equity / market value |
| FCF yield | TTM (operating cash flow − capital expenditure) / market value |
| ROE | TTM net income / equity |
| debt-to-equity | Long-term debt / equity |
| revenue growth | TTM revenue / TTM revenue four quarters earlier − 1 |
| dividend yield | TTM dividends paid / market value |
| EBITDA yield | TTM (operating income + depreciation and amortization) / enterprise value (market value + long-term debt − cash) |
| … vs sector | Earnings yield or book-to-price minus the median of the company's sector that day |

- **Sectors**: from each company's SEC SIC code, grouped into broad sectors. The median uses every company in the data release from that sector, not only the stocks in the request, and needs at least three values that day.
- **Release format**: the raw `companyfacts` files are stored by content hash, with a small digest per company (dated series, no prices). A research run reads only the digests.

- **Quarters**: taken from 3-month facts, or from differences of year-to-date facts. Cash-flow statements are cumulative.
- **Market value**: split-adjusted close × shares outstanding put on the same split basis. Dividend-adjusted prices are not used for valuation.
- **Backtester input**: the values are attached to the price panel as point-in-time columns, so the same "rows ≤ t" slicing and the same future-data perturbation test cover them.

Trading-activity signals for every stock and fund (`engine/agent/xtxc_agent/research/volume.py`) use the same columns:
**volume surge** (20-day / 120-day average volume − 1) and **dollar volume** (log10 of 20-day average dollars traded).

## Research universe

Every Ondo or bStock token on BSC whose underlying has at least 1,135 sessions of verified daily history (enough for a one-year held-out test): **381 tickers**, 293 stocks and 88 funds, from a Binance Web3 RWA Data snapshot. `dev/gen_bsc_universe.py` regenerates the list; execution re-checks each token's live status and contract.

A request that names a theme (dividends, value, a sector, crypto) starts from a group built from the same data by `dev/gen_bsc_themes.py`: SIC sector, dividends paid and filings on record, ranked by trading volume. A request with no theme starts from the most traded companies with filings, taking turns across sectors. These groups only seed a draft the user reviews; the agent's rules and the backtests decide.

## Repository layout

```text
engine/                         research engine (Python) + execution services (Node)
  agent/xtxc_agent/research/    strategy language (price + fundamental signals), backtester, agent profiles,
                                agent_rules.json (the rule catalog), fundamentals.py
  compute/                      design bridge: model designs → agent rules → isolated backtests → report
  bnb-gateway/server.mjs        Binance Web3 API + Agentic Wallet gateway
  lib/                          store, BSC execution checks, Agentic execution, Binance client (shared with web/)
  scripts/research-agent-worker.mjs   research queue + Agentic Wallet execution loop
  tests/, agent/tests/          JS and Python test suites
web/                            the app's research workspace, agent editor, BSC execution UI and API routes
                                (excerpt of the larger XTXC web app; not a standalone Next.js project)
dev/                            test runner, shared-module sync, end-to-end check, diagnostics
```

## Running it

```bash
# Tests (Python 3.12 with numpy/pandas; Node 22)
dev/test.sh py      # strategy language, fundamentals, agent profiles, design bridge
dev/test.sh js      # agent store, BSC execution checks, gateway, Agentic execution, Binance client

# BNB gateway (needs a Binance Web3 API key; run where the Web3 API is available)
BINANCE_ENV_FILE=…/binance-web3.env GATEWAY_ENV_FILE=…/gateway.env \
BAW_BIN=…/node_modules/@binance/agentic-wallet/dist/index.js BAW_DIR=…/baw \
node engine/bnb-gateway/server.mjs        # listens on 127.0.0.1:4590

# Fundamentals release (SEC EDGAR, content-addressed)
python -m xtxc_agent.research.fundamentals <data-root> AAPL,MSFT,NVDA,…
```

The live app is the hosted way to try it; the `web/` folder is an excerpt and does not build on its own.

## Limitations

- **Coverage of value signals**: none for funds, foreign IFRS filers (TSM, NVO, AZN, ASML) and some multi-class issuers (V, BRK.B). EBITDA yield needs reported operating income, which most banks and some energy companies do not tag. Sectors come from SIC codes plus a short override list for catch-all codes (Visa and Mastercard file under business services and are grouped with financials); they still differ from GICS in places. The research universe is today's listed stocks, so survivorship bias remains.
- **Backtests**: they use underlying-stock price history; tokenized-stock liquidity and fees are modelled as assumptions and checked again at quote time. A backtest is not a forecast.
- **One Agentic Wallet per gateway**: it is bound to the first account that signs in. The CLI stores its session in the OS keychain.
- **Not audited.** Small amounts only.

## Built on

STA (Stock Token Agent), our GWDC 2026 Challenge A entry (2nd place, [xtxctrade/sta](https://github.com/xtxctrade/sta)), which researched and executed tokenized-stock allocations on Solana.

New in this project:
- user-defined agents with code-enforced rules
- technical signals (RSI, Bollinger position, moving-average cross)
- point-in-time SEC fundamentals and the value style
- BNB Smart Chain execution through the Binance Web3 API
- Binance Agentic Wallet autonomy
- the BNB gateway

Market data and execution routes belong to their providers.

## Team

Built by members of **Blackstone**, a university blockchain collective.

| Name | Responsibility | University |
| --- | --- | --- |
| 조민석 | Backend | Seoul National University |
| 양주원 | Frontend | Chung-Ang University |
| 허운 | Smart contracts | Chung-Ang University |
| 제갈민 | Data analysis | Sungkyul University |

See [NOTICE.md](NOTICE.md) for the source, data and dependency boundaries.
