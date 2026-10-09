# STA Agents — your own investing agent for tokenized stocks on BNB Chain

**Give an AI agent your investing style. Code holds it to that style and backtests every idea; once you approve a tested plan, the agent trades it on its own, only within the limits you set in Binance.**

STA Agents is built for the BNB Hack: Tokenized Stocks Edition. It runs on BNB Smart Chain mainnet with Ondo and bStock tokenized stocks, through the Binance Web3 API and the Binance Agentic Wallet.

> Live app: [xtxc.trade/exchange?view=research](https://xtxc.trade/exchange?view=research) · No wallet? [See the recorded runs](https://xtxc.trade/exchange?view=research&demo=1) (read-only) · Demo video (2:50): [youtu.be/xZxOkPZU9_k](https://youtu.be/xZxOkPZU9_k) · Mainnet transactions: [12 trades on 2026-10-08](#mainnet-transactions-2026-10-08)

---

## Why

AI trading agents arrived in 2026: you name an agent, fund a dedicated account and tell it what to do in chat. But an investing *style* that lives in chat drifts. You re-explain it every time, and nothing checks that a strategy actually followed it.

STA Agents makes the style a saved, versioned setting that the system enforces:

| | Typical chat agent | STA Agents |
| --- | --- | --- |
| Investing style | Re-stated in each prompt | Saved profile: **technical** (trend, dip, breakout, sector rotation, chart patterns) or **value** (deep value, quality, growth at a reasonable price), with rules and risk limits |
| Who enforces the rules | The model, hopefully | **Code** merges the agent's rules into every strategy before testing and checks them on the tested strategy |
| Evidence before money | The model's reasoning | Deterministic backtests: training/held-out split, doubled costs, future-data perturbation, parameter stability |
| Autonomy | On/off | Per agent: **research only**, or **trade on its own within limits** in a Binance Agentic Wallet, where Binance enforces the daily limit. You approve each tested plan once, and **Stop trading** ends every remaining order |

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
Owner approves an exact plan once (legs in USDT; legs under the 5 USDT minimum stay in cash)
      │
Binance Agentic Wallet ─ market orders, one leg at a time, within the daily limit and token scope set in the Binance app
      │
Stop trading ─ ends the account's open plans and sets its agents back to research only · Sell positions ─ exits through the same wallet
```

The hosted app is AI-only (since 2026-10-09): an agent either researches only or trades within its Agentic Wallet limits, and your own wallet is used to sign in. The code also has a per-trade mode, in which your own wallet signs every leg after the checks under *Safety boundaries*. It ran on mainnet on 2026-10-08 (below) and is turned off in the hosted app.

## Binance Web3 API and Agentic Wallet usage

All Binance calls go through one small service, the **BNB gateway** (`engine/bnb-gateway/server.mjs`). It holds the API key and the Agentic Wallet session and exposes a narrow, token-authenticated API to the app. It runs in a region where the Web3 API is available; the app servers never call Binance directly.

| Module | Calls | Used for |
| --- | --- | --- |
| RWA Data | `GET /api/v1/dex/market/rwa/platforms`, `/rwa/tokens` | Ondo and bStock tokens on BSC, underlying ticker, token-to-share ratio, market status (no order is prepared for a token that is not `TRADING`), token prices where no DEX pool is indexed |
| Trading | `GET /api/v1/dex/aggregator/quote`, `/aggregator/swap`, `/aggregator/approve-transaction` | Route and price (shown even when the wallet cannot pay yet), unsigned swap transaction, exact-amount approval of the router |
| Transaction | `POST /api/v1/dex/pre-transaction/simulate`, `GET /post-transaction/transaction-detail-by-txhash` | Dry run before any signature; indexed status after sending |
| Wallet | `GET /api/v1/dex/balance/all-token-balances-by-address` | Holdings view |
| Agentic Wallet (`@binance/agentic-wallet`) | `auth signin/verify`, `wallet address/settings/left-quota`, `market-order swap/list` | QR sign-in from the agent card; the limits Binance enforces; autonomous legs |

## Mainnet transactions (2026-10-08)

One research request, run by two agents with the same rules: *"25 USDT in NVDA, AVGO, MSFT, GOOGL, META, AMZN, AAPL, TSM for one year, targeting 3% a year, max loss 25%"*. Both designs passed (typical year +25.8% and +21.6%, worst drop −21.5% and −21.3% over the whole five-year test), were approved, bought, and then sold back to USDT.

That day both approval modes ran; the hosted app has since kept only the Agentic Wallet one.

**You approve every trade** (per-trade mode, now off in the hosted app): Phantom wallet `0xf418755edf574Cf8Dc7af11493cE1c9d5c288721`, each leg signed by the owner.

| Side | Stock | Transaction |
|---|---|---|
| Buy | AAPL | [`0x529657d6…4b42`](https://bscscan.com/tx/0x529657d6304282a3a73b84b60280cceb9217125417d20bce929c223765f74b42) |
| Buy | MSFT | [`0x615cd24b…c728`](https://bscscan.com/tx/0x615cd24b2a72c7eab47a3160b8a62acd2923611cf1cee89b163ec2011c5bc728) |
| Buy | NVDA | [`0x491eae04…395c`](https://bscscan.com/tx/0x491eae04702fef234d081b43682c39dce2872051448eec4784f6d4c8024c395c) |
| Sell | NVDA | [`0x41ee0ca4…4238`](https://bscscan.com/tx/0x41ee0ca42e8a6fb434f899402be1def884bdf466f4f62e9917a4656479b24238) |
| Sell | MSFT | [`0x1a42035b…d465`](https://bscscan.com/tx/0x1a42035bb5b0127a41b7c27b5d7bdfb353227a1631784cbfaabf4eef1643d465) |
| Sell | AAPL | [`0x141d0b61…ea3d`](https://bscscan.com/tx/0x141d0b617e95b52a2306db8b3fc2930219b80109d9e5c056c0eac5467e29ea3d) |

**Trades on its own within limits**: Binance Agentic Wallet `0xF89F956e3a3766a2835E3381D1F10910868B5aCe`, one plan approval, then the agent placed each order.

| Side | Stock | Transaction |
|---|---|---|
| Buy | MSFT | [`0x29f83b14…40ae`](https://bscscan.com/tx/0x29f83b14c8cbe6ef5afd22eea77d64306647075a3428a1825ddbf56ae36240ae) |
| Buy | NVDA | [`0x807d0df0…7dba`](https://bscscan.com/tx/0x807d0df0b4b802c2a35a8634c1329ca8f3fafaf5ebf413fa6812f0813e0e7dba) |
| Buy | TSM | [`0x1a0f31ce…6350`](https://bscscan.com/tx/0x1a0f31cefe86c16875581e212627e31092950db7d3ac31db1a05ddc6ec1f6350) |
| Sell | NVDA | [`0xafe86252…f1fd`](https://bscscan.com/tx/0xafe86252fa983d2f3a9148d6bd3746d836213a7eb1066cfa86704eb113c4f1fd) |
| Sell | MSFT | [`0x37a2e58d…577f`](https://bscscan.com/tx/0x37a2e58d0d2491b035c9b8f98867333e81a10cdfbd582ecade8dc1d74ae3577f) |
| Sell | TSM | [`0xdb725691…6874`](https://bscscan.com/tx/0xdb7256917cdf255359ee62a5f2d47bfc28cfcac5ddf117f3fca82d95da186874) |

Earlier hand-signed attempts that reverted (one out of gas, three on expired RFQ orders) led to the two execution checks added under *Safety boundaries*.

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

**Per-trade execution** (the hand-signed mode in the code; off in the hosted app), checked before the wallet is asked to sign:
- The approval is for the exact amount only, never unlimited.
- The swap's target is the documented router, `from` is the owner, `value` is 0, and the selector is known.
- Calldata contains the approved tokens and exact amount, and the minimum received is within slippage.
- The dry run succeeds.
- Routes that fill from a market maker's signed order (RFQ) are skipped: those orders expire seconds after the quote, before a person can confirm in a wallet. With no other route, nothing is offered for signing.
- The gas limit is the node's own estimate plus 30%, never less than the route's figure (one route asked for 250k on a swap that used ~950k).
- BNB for gas and the USDT balance are checked first.
- After the wallet sends, the on-chain transaction must be byte-identical to the prepared one.
- If the wallet's nonce moved after preparation, the same leg is never rebuilt, so it cannot be bought twice.

**Autonomous execution**
- Only plans of agents set to "trade on its own within limits" can start; the server checks the agent's *current* setting.
- Binance enforces the daily USD limit and token scope.
- Each leg is marked durably before its order is placed, and is never resubmitted after an interruption: it becomes "needs a check" instead.
- **Stop trading** revokes the account's open plans, stops its Agentic runs and monitors, and sets its agents back to research only. An order already sent is not cancelled and is still reconciled.

## Company fundamentals for value agents

Value signals come from **SEC EDGAR XBRL company facts** (`engine/agent/xtxc_agent/research/fundamentals.py`): us-gaap facts for US filers and ifrs-full facts for foreign filers (20-F / 40-F), whose figures are converted to USD with FRED daily exchange rates. Each number is usable only from the session after its filing date, so a backtest on day *t* sees what had been published by then.

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
- **Market value**: split-adjusted close × shares outstanding on the same split basis (from the price data's split events) ÷ ordinary shares per ADS for depositary listings. Dividend-adjusted prices are not used for valuation. Checked against Binance RWA Data market values: 314 of 328 companies within 25%.
- **Fresh data**: `engine/scripts/refresh_research_data.py` refreshes the price release, the fundamentals release (only companies with a new filing, plus exchange rates) and the official statistics every weekday after the US close; each release is replaced in one step and a failed refresh keeps the previous one. An exchange rate counts only from the business day after its weekly H.10 release.
- **Backtester input**: the values are attached to the price panel as point-in-time columns, so the same "rows ≤ t" slicing and the same future-data perturbation test cover them.

Trading-activity signals for every stock and fund (`engine/agent/xtxc_agent/research/volume.py`) use the same columns:
**volume surge** (20-day / 120-day average volume − 1) and **dollar volume** (log10 of 20-day average dollars traded).

## Official statistics as sector guards

An agent can turn on a guard that holds part of a sector in cash while an official statistic weakens
(`engine/agent/xtxc_agent/research/macro.py`, strategy-language key `macro_off`):

| Guard | Series (FRED ID) | Stocks it scales |
| --- | --- | --- |
| Chip cycle | Semiconductor and electronic component production (`IPG3344S`, monthly) | semiconductor makers (SIC 3670–3679, 3559, QCOM, ARM, long chip funds) |
| Consumer | Advance retail sales (`RSAFS`, monthly) | consumer discretionary and staples companies and funds (XLY, XLP, XRT, …) |
| Oil | WTI crude oil spot price (`DCOILWTICO`, daily) | energy companies and funds (XLE, XOP, OIH, …) |
| Dollar | Nominal broad US dollar index (`DTWEXBGS`, daily, published weekly) | every stock |

- **No look-ahead**: a FRED observation is dated by the period it measures, not by its release, and is revised later. The engine reads every ALFRED vintage, so on day *t* a backtest sees only values published by the day before, as they stood then.
- **Who turns them on**: an agent's guard rule is always enforced. The design model may also propose a guard when a request is about one of these industries or about macro risk; that candidate then shows an "Official-data guard" line and is tested like any other. No guard is on by default: on 2021–2026 data they did not reduce the largest drawdown of a chip-momentum agent.
- A design with a guard waits for data when the statistics release is missing or more than 14 days old.

This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.

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

The live app is the hosted way to try it; the `web/` folder is an excerpt and does not build on its own. Without a wallet, [the read-only demo](https://xtxc.trade/exchange?view=research&demo=1) shows the two 2026-10-08 runs (agents, research results, approved plans and every trade with its BscScan link) in the same screens.

## Limitations

- **Coverage of value signals**: none for funds and for issuers whose share counts SEC publishes only per class (V, BIDU). EBITDA yield needs reported operating income, which most banks and some energy companies do not tag. Sectors come from SIC codes plus a short override list for catch-all codes (Visa and Mastercard file under business services and are grouped with financials); they still differ from GICS in places. The research universe is today's listed stocks, so survivorship bias remains.
- **Backtests**: they use underlying-stock price history; tokenized-stock liquidity and fees are modelled as assumptions and checked again at quote time. A backtest is not a forecast.
- **One Agentic Wallet per gateway**: it is reserved for the operator account set on the server (`XTXC_AGENTIC_OWNER`). Because the hosted app is AI-only, other accounts can sign in, research and open the read-only demo, but not trade. The CLI keeps its session in the OS keychain, or in a 0600 file where there is none.
- **Not audited.** Small amounts only.

## Built on

STA (Stock Token Agent), our GWDC 2026 Challenge A entry (2nd place, [xtxctrade/sta](https://github.com/xtxctrade/sta)), which researched and executed tokenized-stock allocations on Solana.

New in this project:
- user-defined agents with code-enforced rules
- technical signals (RSI, Bollinger position, moving-average cross, relative strength, money flow), close-based chart
  patterns (range breakout, volatility squeeze, higher highs and lows, double bottom) and exit rules (stop loss,
  trailing stop)
- point-in-time SEC fundamentals and the value style
- official statistics (FRED/ALFRED vintages) as sector guards
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
