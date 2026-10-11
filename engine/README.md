# Engine

The research engine and execution services behind [XTXC Research](https://xtxc.trade/exchange), an AI agent that backtests a plan before it trades tokenized stocks on BNB Smart Chain. The [root README](../README.md) covers the product, the mainnet transactions and how to try it. This page maps the `engine/` folder.

| Path | What it holds |
| --- | --- |
| `agent/xtxc_agent/research/` | Strategy language and backtester (`strategy_lang.py`, `strategies.py`, `backtest.py`), agent profiles and the 40-rule catalog (`agent_profile.py`, `agent_rules.json`), point-in-time SEC fundamentals (`fundamentals.py`), trading-activity signals (`volume.py`), FRED/ALFRED sector guards (`macro.py`) |
| `compute/` | Design bridge: model designs → the agent's rules merged by code → isolated backtests → report (`design_bridge.py`, `evaluate.py`) |
| `bnb-gateway/server.mjs` | The only service that calls Binance: Web3 API (RWA Data, Trading, Transaction, Wallet) and the Agentic Wallet CLI, behind a token-authenticated API |
| `lib/binance-web3.mjs` | Binance Web3 API client |
| `lib/bsc-execution.mjs` | Checks on every approval and swap before signing: router, amounts, slippage, simulation |
| `lib/research-agentic.mjs`, `lib/research-bsc-sell.mjs` | An approved plan → one Agentic Wallet market order per leg; sales back to USDT (the owner's **Sell**, or an exit rule that fired) |
| `lib/research-agent-core.mjs`, `lib/research-agent-profile.mjs`, `lib/agent-rules.mjs`, `lib/research-agent-suggest.mjs` | Agent store, rule checks, catalog rules suggested from free text (each quoting it) |
| `lib/research-intake.mjs`, `lib/research-kiln.mjs` | Request parsing (every number must appear in the request) and the Qwen3 32B (Kiln) client |
| `scripts/research-agent-worker.mjs` | Research queue and Agentic Wallet execution loop |
| `scripts/refresh_research_data.py` | Weekday refresh of prices, fundamentals and official statistics |

Kept from STA, our earlier Solana entry ([skewlabs2/sta](https://github.com/skewlabs2/sta)), with their tests: the Solana execution path (`lib/research-autonomy-*` and the services that use them: Privy signer, devnet policy, StockMesh transaction checks), `programs/xtxc-demo-policy` (Rust), `docs/` and `evidence/`. The BNB Chain path above does not import them.

## Tests

```bash
npm install && npm test   # Node 22: 269 tests (268 pass, 1 skipped)
```

The Python suite (`pytest.ini`: `agent/tests`, `compute`) runs with `../dev/test.sh py`. It uses our server's toolchain paths and needs the token catalog report (`XTXC_CATALOG_REPORT`), which is not in this repository.

See [NOTICE.md](NOTICE.md) for the source, data and dependency boundaries.
