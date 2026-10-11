# XTXC Research — an AI agent that tests before it trades tokenized stocks on BNB Chain

**Tell the agent your goal in plain words. It backtests strategy designs first, keeps only the ones inside your limits, and after one approval trades Ondo and bStock tokenized stocks on BNB Chain mainnet through the Binance Agentic Wallet.**

Our entry to **BNB Hack: Tokenized Stocks Edition** (*Tokenized Stocks Products & Agents* track, *Best Use of Agentic Wallet* prize) is the live site **[xtxc.trade/exchange](https://xtxc.trade/exchange)**. This repository (STA Agents) holds the site's research engine, its Binance gateway and the agent's execution code.

> **Live site:** [xtxc.trade/exchange](https://xtxc.trade/exchange) · **Demo video:** [youtu.be/xZxOkPZU9_k](https://youtu.be/xZxOkPZU9_k) · **No wallet?** [Read-only replay](https://xtxc.trade/exchange?view=research&demo=1) · **Proof:** [20 mainnet transactions](#mainnet-transactions-summary) · **Judges:** [how to try it](#for-judges-how-to-try-it)

## At a glance

| | |
| --- | --- |
| What it is | A trading site for tokenized US stocks with an AI agent: **Markets**, **Research** (your agent), **Portfolio**, **Community** and **Leaderboard** |
| Who it is for | Retail investors who want tokenized stocks on BNB Chain, and an agent that has to prove a plan before it trades |
| Chain and assets | BNB Smart Chain mainnet (chain ID 56), USDT pairs. 448 tokenized stocks and ETFs on Markets (488 Ondo and bStock tokens); 381 with enough verified history form the research universe (293 stocks, 88 funds) |
| The agent | Plain-language goal → budget, period, target and loss limit read from your words (each number must appear in them) → an agent chosen from your words: one of 9 presets plus the rules your request asks for, from a 40-rule catalog → 1–3 typed strategy designs → the agent's rules merged in by code → isolated point-in-time backtests → only designs inside your target and loss limit can be approved |
| Binance Web3 API | RWA Data, Trading (aggregator quote, swap, approve), Transaction (pre-transaction simulate, transaction detail), Wallet (token balances) |
| Binance Agentic Wallet | `@binance/agentic-wallet`: QR sign-in in the Binance app, limits and quota, market-order swaps. After one approval the agent places each order itself, within the daily limit Binance enforces |
| AI | A grounded request parser plus Qwen3 32B (Kiln), which reads requests and proposes typed designs; it never sees prices, places orders or writes code |
| Proof on mainnet | 20 transactions on 2026-10-08 and 2026-10-10, all status 1, [linked below](#mainnet-transactions-summary) |
| Tests | `cd engine && npm install && npm test`: 269 JS tests (agent store, BSC execution checks, gateway, Agentic execution, Binance client); `node --test web/tests/mobile-agent-preset.test.mjs` from the root for the Research screen's agent choice |

## Hackathon requirements: where to verify

| Requirement | Where |
| --- | --- |
| BNB Smart Chain mainnet, live trades | [Mainnet transactions](#mainnet-transactions-summary): 20 BscScan links |
| Tokenized stocks (Ondo, bStocks) | [Binance Web3 API usage](#binance-web3-api-and-agentic-wallet-usage) (RWA Data); bStock tokens such as AMDB, MSFTB and MUB in the 2026-10-10 trades |
| At least one Binance Web3 API module | Four modules plus the Agentic Wallet, served by `engine/bnb-gateway/server.mjs` (API client: `engine/lib/binance-web3.mjs`) |
| Agentic Wallet | `engine/lib/research-agentic.mjs` (approved plan → orders), gateway routes `/v1/agentic/*`, trades sent by `0xF89F956e3a3766a2835E3381D1F10910868B5aCe` |
| Public repository | This repository |
| Deployed link | [xtxc.trade/exchange](https://xtxc.trade/exchange), with [steps for judges](#for-judges-how-to-try-it) |
| Demo video, 4 minutes or less | [youtu.be/xZxOkPZU9_k](https://youtu.be/xZxOkPZU9_k) |

## Judging criteria: where to look

| Criterion | Evidence |
| --- | --- |
| Technical execution | Typed strategy language and backtester (`engine/agent/xtxc_agent/research/strategies.py`, `backtest.py`); agent rules merged and checked by code (`agent_profile.py`, `agent_rules.json`); design bridge with training-only selection, held-out horizons, doubled-cost stress and a future-data check (`engine/compute/design_bridge.py`, `evaluate.py`); point-in-time SEC fundamentals and FRED/ALFRED vintages; a gateway that checks every route before an order (`engine/bnb-gateway/server.mjs`, `engine/lib/bsc-execution.mjs`) |
| Creativity | The request picks its own agent: a style and preset from your words plus the catalog rules you ask for (`web/lib/mobile-agent-preset.mjs`). An agent that must prove a plan before it may trade: every design is backtested and marked *within your goal* or *outside your goal*, and one approval covers a whole tested plan. Copying another trader's allocation also goes through your own agent (preview) |
| User experience | On the site: Markets with live status and charts → *Ask your agent* → a goal in plain words → tested plan → **Approve & start** → orders with BscScan links → Portfolio with on-chain holdings and **Sell**; **Pause trading** at any time ([demo video](https://youtu.be/xZxOkPZU9_k)) |
| Developer experience | Our Developer Experience Report goes through the official form; the gateway gives the site a narrow, token-authenticated API over the Binance Web3 API and the Agentic Wallet CLI ([run it yourself](#for-judges-how-to-try-it)) |

---

## Why

AI trading agents arrived in 2026: you name an agent, fund an account and tell it what to do in chat. Most of them act on a prompt. XTXC Research makes the agent prove a plan first:

| | Typical chat agent | XTXC Research |
| --- | --- | --- |
| Evidence before money | The model's reasoning | Deterministic backtests: training/held-out split, doubled costs, future-data perturbation, parameter stability |
| Who enforces the rules | The model, hopefully | **Code** merges the agent's rules into every design before testing and checks them on the tested design |
| Your limits | Restated in each prompt | Read from your words (target, loss limit, cash, per-stock cap) and never loosened by the agent |
| Autonomy | All or nothing | One approval for one tested plan; Binance enforces the daily limit; **Pause trading** and **Sell** at any time |

## The site

### Markets
- 448 tokenized stocks and ETFs (488 Ondo and bStock tokens), with live token prices, the change since the last close and each token's market status: tradable now, or when its market reopens. Search, and Stocks / ETFs filters.
- Charts with real 5-minute and hourly candles (1H, 4H, 1W, 1M, 3M, 1Y), as a line or as candles, and token facts (token price, estimated market cap, last-session stock volume).
- **Buy** and **Sell** directly from your own wallet, each order signed by you. A closed market cannot be ordered.
- *Ask your agent about NVDA* opens Research with that stock in the prompt.

### Research: your agent
- Write a goal: budget, period, target, loss limit, and stocks or a theme. The demo video uses `Invest $30 for one year in the best 3 of NVDA, AMD, AVGO, TSM, MU, MSFT, GOOGL and META, targeting 5%, max loss 40%. No more than 3 stocks.`
- In about a minute the agent shows its tested designs, each with its held-out backtest return, maximum drawdown and allocation, marked *Within your goal* or *Outside your goal*. Only a design inside your limits gets **Approve & start · $budget**.
- After approval the agent places each order through the Binance Agentic Wallet. Each leg shows *Queued*, *Order in progress* and then *Purchased* with a BscScan link. **Pause trading** stops it.
- Each request runs with the agent its words ask for, chosen once the request is complete, and the chat names it before the test (for example *Agent: Value · Dividend value. Rules: …*):
  - **Style and preset** from the request: technical (trend follower, dip buyer, breakout, sector rotation, chart patterns) or value (deep value, quality at a fair price, growth at a reasonable price, dividend value). Korean and English requests both work: "undervalued dividend stocks" runs the dividend-value agent; "buy the dip" runs the dip buyer.
  - The newest message counts first: a follow-up such as "switch to buying the dip" changes the agent, while "$100, one year" keeps the one already asked for. A negated ask picks nothing ("avoid dividend stocks", "no dividend payers", "without dividends"). Growth alone is not growth at a reasonable price; that needs a price word too ("undervalued growth stocks", "growth at a reasonable price"). A take-profit level ("sell when it breaks through +5%") is not a breakout strategy; the breakout agent needs a breakout or a high ("breakout stocks", "new highs", "52-week highs").
  - A value request whose stocks are all ETFs runs the trend follower instead, because funds have no company financials for a value screen; the chat line says so.
  - **Rules the request asks for** are added from the style's part of the 40-rule catalog (29 technical, 25 value rules), each quoting your words, within the limits of 8 rules and 6 stock filters: "3 stocks" adds *Max holdings*, "stop loss 10%" adds *Stop loss*; a number for a rule the preset already has replaces the preset's ("RSI below 25" sets the dip buyer's *Buy the dip* level to 25 instead of 40). Suggestions use the model and share its daily budget, so they are asked for only once the request is complete and only when it names a rule-like condition (a number of stocks, a stop, RSI, a moving average, P/E, debt, a sector, volume and similar). If the combination is refused, the preset alone runs.
  - **Agents are reused.** An agent is saved under a hash of its rules and limits, so the same request maps to the same saved agent instead of adding one each time. A wallet keeps at most 10 agents; at that limit the test runs with the closest saved agent of the same style that may trade on its own (same preset and rules first), and the chat says so.
  - A request that names no style, or asks for a trend ("momentum", "uptrend", "trend following"), runs the trend follower: *Uptrend only* (stocks above their 200-day average), *Strongest momentum* (the top half by six-month return, skipping the last month) and *Market guard* (half exposure while QQQ is below its 200-day average), rebalanced monthly.

### Portfolio
- Total stock value and an allocation chart, from on-chain balances of your wallet and, for the operator account, the Agentic Wallet.
- Each Agentic Wallet position has **Sell**: the agent closes it through the same wallet, and the row shows *Selling…* and then *Sold* with its BscScan link. If the sale can't trade yet (closed market, route price check, Binance daily limit), the row shows *Queued* with the reason: the agent retries every five minutes until the sale plan expires, and the page keeps checking (every 30 seconds after the first three minutes, for up to two hours) instead of staying at *Selling…*.
- *Profile & settings*: name and handle, a public trading profile, the Agentic Wallet connection (QR sign-in in the Binance app) and sharing your allocation.

### Community and Leaderboard (preview)
- A feed whose ticker links open your agent, a leaderboard by realized trading profit, and trader profiles with a versioned shared allocation.
- *Follow @trader with $100* in Research opens a follow plan: match their portfolio now or follow only future rebalances, with 0.5% price protection, for 30 days. In this build follow plans are saved paused and never trade.
- The demo video shows these screens with labelled sample data (`?showcase=1`); without it you see the live, still small community.

### Advanced: build your own agent
- The same site has an agent workspace at [`?view=research&terminal=1`](https://xtxc.trade/exchange?view=research&terminal=1). **Create an agent** there: a technical style (trend, dip, breakout, sector rotation, chart patterns) or a value style (deep value, quality at a fair price, growth at a reasonable price, dividend value), or a custom set of rules from a catalog of 40, plus risk limits, rebalancing and autonomy. Research there is bound to that agent's version, and **Stop trading** and **Sell positions** sit next to the prompt.
- Without a wallet, the [read-only replay](https://xtxc.trade/exchange?view=research&demo=1) shows two such agents, their rules and their 2026-10-08 mainnet runs.

## How it works

```text
Markets ─ 448 stocks and ETFs · live status · charts · direct buy and sell ───┐
                                                                              │ "Ask your agent"
Research ─ "Invest $30 … the best 3 of 8 AI stocks … target 5%, max loss 40%" ◄┘
      │
Request ─ grounded parser + Qwen3 32B (Kiln): budget, period, target, loss limit, stocks; every number must appear in your words
      │
Agent ─ chosen from your words: 1 of 9 presets + catalog rules the request asks for (each quoting it, ≤ 8 rules, ≤ 6 filters) · same rules and limits → same saved agent · or your own agent
      │
Designs ─ Qwen3 32B proposes 1–3 typed strategy designs (no code, no prices seen) · code merges the agent's rules
      │
Isolated backtests ─ point-in-time prices and fundamentals · training-only selection · held-out horizons
      │             doubled costs · future-data check · parameter stability
      ▼
Report ─ each design "within your goal" or "outside your goal", with the reasons
      │
Approve & start ─ one approval for the exact plan (legs in USDT; legs under the 5 USDT minimum stay in cash)
      │
Binance Agentic Wallet ─ one market order per leg, within the daily limit and token scope set in the Binance app · a BscScan link per leg
      │
Portfolio ─ on-chain holdings · Sell through the same wallet · Pause trading ends every remaining order
```

## For judges: how to try it

**1. The live site, no setup:** [xtxc.trade/exchange](https://xtxc.trade/exchange)

- **No wallet.** Browse Markets and charts. The [read-only replay](https://xtxc.trade/exchange?view=research&demo=1) shows the 2026-10-08 mainnet runs: the agents, their research reports, the approved plans and every trade with its BscScan link. The [sample community](https://xtxc.trade/exchange?view=community&showcase=1) shows Community and Leaderboard with labelled sample data.
- **Signed in.** Connect at the top right with Google or a wallet (Phantom, MetaMask, Binance Wallet, Coinbase Wallet or WalletConnect); a wallet sign-in takes one signature, which sends nothing.
  - *Markets*: buy or sell a token directly from your own wallet; a few USDT and a little BNB for gas are enough.
  - *Research*: send the goal above, or your own. Your research stays listed under *Your agents*.
  - *Portfolio*: your on-chain holdings.
- **What visitors cannot do: start autonomous trading.** The site's gateway drives one Binance Agentic Wallet, the operator's (`XTXC_AGENTIC_OWNER`), and **Approve & start** is refused for every other account, so visitors cannot trade the operator's funds. The demo video shows the operator's live runs, and every trade is listed under the mainnet transactions below.

**2. Run the checks**, on any machine with Node 22:

```bash
git clone https://github.com/won-topiaa/sta-agents && cd sta-agents/engine
npm install && npm test    # 269 tests: agent store, BSC execution checks, gateway, Agentic execution, Binance client
cd .. && node --test web/tests/mobile-agent-preset.test.mjs   # the agent a Research request runs with
```

The Python suite (`dev/test.sh py`) also needs the token catalog report (`XTXC_CATALOG_REPORT`), which is not in this repository.

**3. Drive your own Agentic Wallet through the gateway.** You need a Binance Web3 API key and the Agentic Wallet CLI (`npm install @binance/agentic-wallet`). Run this from the repository root, where the Binance Web3 API is available:

```bash
printf 'BINANCE_WEB3_API_KEY=…\nBINANCE_WEB3_SECRET_KEY=…\n' > binance-web3.env
printf 'GATEWAY_TOKEN=%s\n' "$(openssl rand -hex 24)" > gateway.env
BINANCE_ENV_FILE=binance-web3.env GATEWAY_ENV_FILE=gateway.env \
BAW_BIN=node_modules/@binance/agentic-wallet/dist/index.js BAW_DIR=./baw \
node engine/bnb-gateway/server.mjs &                       # listens on 127.0.0.1:4590

T=$(sed -n 's/^GATEWAY_TOKEN=//p' gateway.env); G=http://127.0.0.1:4590
curl -s -X POST -H "Authorization: Bearer $T" $G/v1/agentic/signin    # a sign-in link and qrCodeId: confirm in the Binance app
curl -s -X POST -H "Authorization: Bearer $T" -d '{"qrCodeId":"…"}' $G/v1/agentic/verify
curl -s -H "Authorization: Bearer $T" $G/v1/agentic/quota             # the daily limit Binance enforces
curl -s -H "Authorization: Bearer $T" $G/v1/universe                  # Ondo and bStock tokens with their trading status
```

The site and its worker place an approved plan's orders through these same routes (`engine/lib/research-agentic.mjs`). The `web/` folder is an excerpt of the larger site and does not build on its own.

## Binance Web3 API and Agentic Wallet usage

All Binance calls go through one small service, the **BNB gateway** (`engine/bnb-gateway/server.mjs`, with its Web3 API client in `engine/lib/binance-web3.mjs`). It holds the API key and the Agentic Wallet session and exposes a narrow, token-authenticated API to the app. It runs in a region where the Web3 API is available; the app servers never call Binance directly.

| Module | Calls | Used for |
| --- | --- | --- |
| RWA Data | `GET /api/v1/dex/market/rwa/tokens` (platforms `bstock`, `ondo`) | Ondo and bStock tokens on BSC, underlying ticker, token-to-share ratio, market status (no order is prepared for a token that is not `TRADING`), token prices where no DEX pool is indexed |
| Trading | `GET /api/v1/dex/aggregator/quote`, `/aggregator/swap`, `/aggregator/approve-transaction` | Route and price (shown even when the wallet cannot pay yet), unsigned swap transaction, exact-amount approval of the router |
| Transaction | `POST /api/v1/dex/pre-transaction/simulate`, `GET /post-transaction/transaction-detail-by-txhash` | Dry run before any signature; indexed status after sending |
| Wallet | `GET /api/v1/dex/balance/all-token-balances-by-address` | Holdings view |
| Agentic Wallet (`@binance/agentic-wallet`) | `auth signin/verify`, `wallet address/settings/left-quota`, `market-order swap/list` | QR sign-in from the agent card; the limits Binance enforces; autonomous legs |

## Mainnet transactions: summary

| Date | Wallet | Mode | Transactions | Stocks |
| --- | --- | --- | --- | --- |
| 2026-10-08 | Phantom `0xf418…8721` | Per-trade: the owner signs each leg | 6 | AAPL, MSFT, NVDA bought and sold |
| 2026-10-08 | Agentic Wallet `0xF89F…5aCe` | On its own within limits | 6 | MSFT, NVDA, TSM bought and sold |
| 2026-10-10 | Agentic Wallet `0xF89F…5aCe` | On its own within limits | 2 | MSFT bought and sold |
| 2026-10-10 | Agentic Wallet `0xF89F…5aCe` | On its own within limits; the agent chose 3 of 8 stocks | 6 | AMD, MSFT, MU bought and sold |

All 20 succeeded (status 1); each one is linked below.

## Mainnet transactions (2026-10-08)

One research request, run by two agents with the same rules: *"25 USDT in NVDA, AVGO, MSFT, GOOGL, META, AMZN, AAPL, TSM for one year, targeting 3% a year, max loss 25%"*. Each agent's approved design passed (typical year +25.8% and +21.6%, worst drop −21.5% and −21.3% over the whole five-year test); both were bought and then sold back to USDT.

That day both approval modes ran. On the site, agents now trade only through the Agentic Wallet; your own wallet signs the direct buys and sells on Markets.

**You approve every trade** (the per-trade agent mode, now off on the site): Phantom wallet `0xf418755edf574Cf8Dc7af11493cE1c9d5c288721`, each leg signed by the owner.

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

## Mainnet transactions (2026-10-10)

Two runs from the new app, both recorded for the demo. All eight transactions were sent by the Agentic Wallet `0xF89F956e3a3766a2835E3381D1F10910868B5aCe`.

**First run**: *"Invest $25 in NVDA, MSFT and TSM for one year, targeting 3%, max loss 25%"*. Within that loss limit, both eligible designs held MSFT 40% and kept 60% in cash. After one plan approval, the Agentic Wallet bought MSFT; the same position was later sold from the Portfolio screen through the strategy's sale plan.

| Side | Stock | Transaction |
|---|---|---|
| Buy | MSFT | [`0xb57f076f…0b2f`](https://bscscan.com/tx/0xb57f076fbf97e89e8df1869bc62cc1d44d0da58dba37308b8f07d5dc6fb60b2f) |
| Sell | MSFT | [`0xeae6ca76…0aa1`](https://bscscan.com/tx/0xeae6ca76b877701ea6dff783af6e7f8fdcab86c9c47cafa4ad89ff56f3b70aa1) |

**Second run**, letting the agent choose the stocks: *"Invest $30 for one year in the best 3 of NVDA, AMD, AVGO, TSM, MU, MSFT, GOOGL and META, targeting 5%, max loss 40%. No more than 3 stocks."* One of the two designs tested passed (held-out test: +347.4% return, −25.9% max drawdown); it held AMD, MSFT and MU at 30% each with 10% in cash, and the other design was rejected. After one approval the Agentic Wallet bought all three in under a minute. Each position was then sold from the Portfolio screen.

| Side | Stock | Transaction |
|---|---|---|
| Buy | AMD | [`0x8aa91501…344e`](https://bscscan.com/tx/0x8aa91501d50838944e7c30f71d66aca6821253c2629294a7b11beb2818c3344e) |
| Buy | MSFT | [`0xa638664d…bcf8`](https://bscscan.com/tx/0xa638664d0678559ed82de052daeecc2f6ecc807718db12e029c00af71a7ebcf8) |
| Buy | MU | [`0x9d220114…5aff`](https://bscscan.com/tx/0x9d220114aa5e5dc6be05184beebeab1ea9a5bb2b298567c508841334df445aff) |
| Sell | MSFT | [`0x42b16478…6b66`](https://bscscan.com/tx/0x42b1647859071a038a0b44dade19ddd4c004efc7df0f1dd2b72cad498ca76b66) |
| Sell | MU | [`0x75bc6c33…85f2`](https://bscscan.com/tx/0x75bc6c33bff41bd16e349b2d79780b43ba878c3b8ddf2870b3f25cca7bb685f2) |
| Sell | AMD | [`0x07abe54c…3cd9`](https://bscscan.com/tx/0x07abe54c04685b7181640f8a4fa68324e88c12619ef8f7d2bce92d4c40703cd9) |

## Safety boundaries

**The model**
- It proposes designs only: typed data, size-limited, no code, no tools, no signing.
- It never sees price history, so it cannot fit a design to the backtest.
- Free text becomes rules only from a fixed catalog, and each suggested rule must quote the words that ask for it. In the agent editor, a philosophy's suggestions are offered for the owner to add. On the Research screen, the request picks the preset, and the rules it asks for are added automatically and named in the chat before the test; only a complete request that names a rule-like condition is sent for suggestions.

**Agent rules**
- Rules are merged into every candidate by code.
- A technical agent cannot use company fundamentals; a value agent must score at least one.
- Compliance is checked on the exact design that was backtested, and approval requires every rule to show as kept.
- Editing the agent invalidates earlier results.

**Per-trade execution** (the hand-signed agent mode in the code; off for agents on the site), checked before the wallet is asked to sign:
- The approval is for the exact amount only, never unlimited.
- The swap's target is the documented router, `from` is the owner, `value` is 0, and the selector is known.
- Calldata contains the approved tokens and exact amount, and the minimum received is within slippage.
- The route's price may be at most 3% worse than the token's reference price (the underlying share price × the token ratio), and its price impact at most 2%.
- The dry run succeeds.
- Routes that fill from a market maker's signed order (RFQ) are skipped: those orders expire seconds after the quote, before a person can confirm in a wallet. With no other route, nothing is offered for signing.
- The gas limit is the node's own estimate plus 30%, never less than the route's figure (one route asked for 250k on a swap that used ~950k).
- BNB for gas and the USDT balance are checked first.
- After the wallet sends, the on-chain transaction must be byte-identical to the prepared one.
- If the wallet's nonce moved after preparation, the same leg is never rebuilt, so it cannot be bought twice.

**Autonomous execution**
- Only plans of agents set to "trade on its own within limits" can start; the server checks the agent's *current* setting.
- Binance enforces the daily USD limit and token scope.
- Each order is re-quoted first and refused if the route is more than 3% worse than the token's reference price or its price impact is above 2%; slippage is set to 1% and MEV protection is on.
- Each leg is marked durably before its order is placed, and is never resubmitted after an interruption: it becomes "needs a check" instead.
- **Stop trading** (**Pause trading** on the main Research screen) revokes the account's open plans, stops its Agentic runs and monitors, and sets its agents back to research only. An order already sent is not cancelled and is still reconciled.

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
web/                            the app's research workspace, agent editor, BSC execution UI and API routes;
                                lib/mobile-agent-preset.mjs picks each Research request's agent (preset + requested rules)
                                lib/mobile-research.mjs starts it: request → agent (saved under a hash of its rules and
                                limits, reused at the 10-agent limit) → strategy → backtest
                                (excerpt of the larger XTXC web app; not a standalone Next.js project. The site's
                                app shell, with the Markets, Portfolio and Community screens, is not included)
dev/                            test runner, shared-module sync, end-to-end check, diagnostics
```

## Running it

```bash
# Every command runs from the repository root.
# Tests (Python 3.12 with numpy/pandas; Node 22)
(cd engine && npm install && npm test)   # JS: agent store, BSC execution checks, gateway, Agentic execution, Binance client
node --test web/tests/mobile-agent-preset.test.mjs   # the agent a Research request runs with (preset + requested rules)
dev/test.sh py      # Python: strategy language, fundamentals, agent profiles, design bridge
                    # (dev/test.sh uses our server's toolchain paths and needs XTXC_CATALOG_REPORT)

# BNB gateway (needs a Binance Web3 API key; run where the Web3 API is available)
BINANCE_ENV_FILE=…/binance-web3.env GATEWAY_ENV_FILE=…/gateway.env \
BAW_BIN=…/node_modules/@binance/agentic-wallet/dist/index.js BAW_DIR=…/baw \
node engine/bnb-gateway/server.mjs        # listens on 127.0.0.1:4590

# Fundamentals release (SEC EDGAR, content-addressed)
(cd engine/agent && python -m xtxc_agent.research.fundamentals <data-root> AAPL,MSFT,NVDA,…)
```

The live site is the way to try it; the `web/` folder is an excerpt and does not build on its own. Without a wallet, [the read-only replay](https://xtxc.trade/exchange?view=research&demo=1) shows the two 2026-10-08 runs (agents, research results, approved plans and every trade with its BscScan link) in the same screens.

## Limitations

- **Coverage of value signals**: none for funds (a value request for funds only runs the trend follower instead) and for issuers whose share counts SEC publishes only per class (V, BIDU). EBITDA yield needs reported operating income, which most banks and some energy companies do not tag. Sectors come from SIC codes plus a short override list for catch-all codes (Visa and Mastercard file under business services and are grouped with financials); they still differ from GICS in places. The research universe is today's listed stocks, so survivorship bias remains.
- **Backtests**: they use underlying-stock price history; tokenized-stock liquidity and fees are modelled as assumptions and checked again at quote time. A backtest is not a forecast.
- **One Agentic Wallet per gateway**: it is reserved for the operator account set on the server (`XTXC_AGENTIC_OWNER`). Other accounts can sign in, research, buy and sell directly from their own wallet, and open the read-only replay, but they cannot start autonomous trading. The CLI keeps its session in the OS keychain, or in a 0600 file where there is none.
- **Not audited.** Small amounts only.

## Built on

STA (Stock Token Agent), our GWDC 2026 Challenge A entry (2nd place, [skewlabs2/sta](https://github.com/skewlabs2/sta)), which researched and executed tokenized-stock allocations on Solana.

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
| Minseok Cho | Backend | Seoul National University |
| Juwon Yang | Frontend | Chung-Ang University |
| Un Heo | Smart contracts | Chung-Ang University |
| Min Jegal | Data analysis | Sungkyul University |

See [NOTICE.md](NOTICE.md) for the source, data and dependency boundaries.
