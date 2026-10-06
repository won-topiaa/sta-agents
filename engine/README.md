# STA — Stock Token Agent

**Research a stock allocation. Test the idea. Approve a version. Account for what actually happened.**

STA turns a plain-language stock-investing goal into measured strategy candidates and owner-approved, policy-gated execution through XTXC.

An agent can write a convincing investment thesis without having a viable strategy. It can also produce a valid transaction without having permission to spend. STA treats those as two different problems, and makes neither one the model's decision.

The model interprets the request and proposes bounded strategy designs. The existing PR5 data layer and PR7 strategy executor evaluate them with deterministic backtests. The user approves a particular version. A separate execution service checks the actual transaction, reserves the approved allowance, requests a signature and reconciles delivery.

[Read the architecture](docs/ARCHITECTURE.md) · [Inspect the evidence](docs/EVIDENCE.md) · [Review the trust boundary](docs/SECURITY.md) · [See what is new](docs/PROVENANCE.md)

## One request, several boundaries

> “Research semiconductors for one year with 100 USDC. Test a 5% target.”

```text
Plain-language request + optional stock selection
       │
       ▼
Kiln / Qwen ── typed research draft; no executable code or signing tools
       │
       ▼
Sealed data release → deterministic backtests → independent result checks
       │                                       │
       │                                       └─ unsupported goal → DECLINED
       ▼
Candidate report → owner approves exact plan version → explicit Start
       │
       ▼
StockMesh quote → inspect exact transaction → simulate
       │
       ▼
Devnet policy reservation → isolated Privy signer → mainnet StockMesh
       │                                                 │
       └──────────── result commitment ◀── finalized debit + delivery
```

**Mainnet is the execution chain. Devnet is the policy-recording and evidence chain.** Devnet cannot enforce a mainnet spending limit by itself. The isolated signer gate is a trusted component, not a cross-chain proof. A hash is not a fill. A test pass is not a trade.

## What is in this repository

This is the **GWDC 2026 Challenge A hackathon source snapshot**, separated from the existing XTXC exchange. XTXC/StockMesh remains the external execution system; its older router is [credited separately](https://github.com/xtxctrade/xtxc), not presented as new work.

| Component | Implementation | Boundary worth reading |
| --- | --- | --- |
| Natural-language intake | [research-intake.mjs](lib/research-intake.mjs) | Numerical goals must be grounded in the user's words; stock clicks are optional |
| Model invocation | [research-kiln.mjs](lib/research-kiln.mjs) | Typed proposal, bounded response, metered tokens, no trading tools |
| Data releases | [quantstore.py](agent/xtxc_agent/research/quantstore.py), [marketdata.py](agent/xtxc_agent/research/marketdata.py) | Content hashes, coverage checks, synthetic-history quarantine |
| Strategy engine | [strategy_lang.py](agent/xtxc_agent/research/strategy_lang.py), [backtest.py](agent/xtxc_agent/research/backtest.py) | Restricted strategy language, next-session execution, post-cost equity |
| Candidate acceptance | [design_bridge.py](compute/design_bridge.py), [research-evaluation-audit.mjs](lib/research-evaluation-audit.mjs) | Training-only selection, held-out windows, doubled costs, future-data perturbation and parameter stability |
| Execution economics | [execution_costs.py](agent/xtxc_agent/research/execution_costs.py), [exectape.py](agent/xtxc_agent/research/exectape.py) | Token atoms, stock-share exposure and observed costs remain distinct |
| Approval and execution | [research-autonomy-control.mjs](lib/research-autonomy-control.mjs), [research-autonomy-runtime.mjs](lib/research-autonomy-runtime.mjs) | Exact approved version; owner Start; no generic signing endpoint |
| Transaction inspection | [research-autonomy-wire.mjs](lib/research-autonomy-wire.mjs) | StockMesh opcode, wallet accounts, minimum output, fees and ALT state |
| Recovery journal | [research-autonomy-journal.mjs](lib/research-autonomy-journal.mjs) | Persist before signing; unresolved exposure survives restarts and policy changes |
| On-chain policy | [Rust program](programs/xtxc-demo-policy/src/lib.rs) | Fixed-size ordered trade commitment; mint, side, quantity, minimum sale proceeds, budget and revocation |

The smaller Python API under `agent/xtxc_agent/core` supports research, reporting and **local-chain** exercises. It is not the deployed Privy/mainnet execution service. The active execution path is the JavaScript control/runtime path above. The old exchange frontend and archived UI prototypes are intentionally not duplicated here.

## Engineering decisions, not adjectives

### The model does not grade its own idea

The production worker asks Kiln for up to three restricted strategy-language designs **without showing it the backtest prices**. It invokes the existing PR7 validator, executor and backtester, rather than approximating that engine with three fixed templates. Candidate selection uses training data. Held-out results, doubled costs, future-data perturbation and lookback stability are checked afterwards. No arbitrary model-generated Python is executed.

The data release uses the collected 58-stock universe independently of the execution catalog. In the previous integration, an older 50-stock catalog accidentally filtered already-collected ASML history out of the release. The repaired release retains all 58 research symbols. Repeated dependency failures terminate instead of keeping the user in an endless waiting state.

### An uncertain signature is an unresolved liability

If a signer times out, the system cannot assume that no signature exists. It records `SIGNING_UNKNOWN`, blocks a new order for that wallet and does not automatically sign a replacement. A relay retry reuses the exact signed bytes. A timeout never replenishes an allowance.

Stopping one policy and creating another does not escape the wallet-wide unresolved-order fence. [The restart and cross-policy tests](tests/research-autonomy.test.mjs) exercise that distinction.

### Approval binds the transaction, not the button

The gate checks the approved owner, plan version, wallet, budget and mint universe. It then decodes the prepared transaction and verifies permitted StockMesh instructions, account roles, amount, minimum output and fee bounds. Provider consent and signer policy must still match immediately before signing.

A finalized receipt must match the signed wire and show the expected source debit and destination credit: USDC to stock for a buy, stock to USDC for a sell. A successful API response or transaction signature alone cannot create a delivered position.

### Fifty-eight stocks do not require fifty-eight approval accounts

Policy v2 commits the ordered trade list with a domain-separated Merkle root. Its approval instruction is 201 bytes whether the plan contains one stock or 58. Each step proves its index, side, mint, exact input and minimum sale proceeds. The fixed 616-byte policy retains counters, revocation and the pending-message fence. The bounded envelope is 64 distinct stock mints and 128 trade legs, not eight inline mint slots.

Holdings-aware allocations bind the agent wallet's actual snapshot. Approved sells settle before dependent buys. Sale quantities use token atoms; only buys consume the USDC buy allowance. Funds and remaining holdings are rechecked before each step, and an ambiguous previous order blocks the next one.

### Units and history are first-class inputs

Money uses integer atoms at execution boundaries. Research uses numerical arrays, but converting a token balance to a stock exposure is explicit. An issuer's share ratio, token premium and price history are not interchangeable.

Adjusted historical prices are retrospective research inputs—not a claim of point-in-time fundamentals. Snapshots are sealed and hashed; missing or suspected synthetic history is not replaced with a flattering curve. Yahoo chart data and yfinance are also **not independent market-data vendors**.

## Run the bounded checks

Use **Linux, Node 22.13+ within the 22.x line, Python 3.12 and Rust**. The publication run used Node 22.23.2. No API keys, wallet funding, RPC endpoint or historical-price download is needed for the default suites.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run verify:bundle

python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
export XTXC_CATALOG_REPORT="$PWD/fixtures/catalog-observation.json"
export XTXC_DATA_DIR="$PWD/.local/no-live-data"
export XTXC_KILN_OFFLINE=1
python -m pytest -q

cargo test --locked --manifest-path programs/xtxc-demo-policy/Cargo.toml
```

The catalog file is a historical **identity fixture**, not a live liquidity feed. Tests needing privately retained price snapshots skip explicitly. CI runs JavaScript and Python suites inside an empty network namespace after installing dependencies. The commands above do not start trading services.

For module responsibilities, controlled provider checks and the SVM harness, see [the runbook](docs/RUNBOOK.md). Raw prices, customer databases, wallet credentials and deployer keys are not distributed.

## Evidence you can inspect

* [Publication verification](evidence/verification.json): exact suite results, scope and checksums.
* [Kiln observations](evidence/kiln-observed.json): actual historical provider/model calls, input/output token counts and proposal hashes; ordinary research and a rejected target are separate records.
* [Devnet observations](evidence/devnet-observed.json): deployment, policy creation, reservation and revocation transaction signatures; negative simulations are labeled as simulations.
* [Research integration](evidence/research-integration-20260930.json): actual production Kiln/PR7 result, source release and ASML coverage, without user identity or raw prices.
* [Policy v2 SVM](evidence/policy-v2-svm.json): 227 compiled-program checks, including 58-stock mixed buy/sell plans and altered-proof rejection. No mainnet transaction is counted here.
* [Policy v2 deployment](evidence/devnet-v2-observed.json): finalized devnet upgrade, unchanged program/upgrade authority and byte-for-byte deployed code verification.
* [Service integration](evidence/service-integration-20260930.json): new approval UI and isolated signer promoted with zero running policies; deployment never starts a trade.
* [Source provenance](evidence/source-provenance.json): original source hashes, observed modification times and publication modifications. These are not fabricated Git commits or proof of original authorship.

Devnet program: [`3i5oG6xw28CTDHf4q49MRxkr6z3uzvMwhtf9FK5qH4pr`](https://explorer.solana.com/address/3i5oG6xw28CTDHf4q49MRxkr6z3uzvMwhtf9FK5qH4pr?cluster=devnet).

The September 30 V2 deployment ELF hash is `06bddfd62810eb89fec0cc58137209ed56aff911aac361a446a319c4501108dd`. The separately retained V1 evidence is historical. The Rust policy implementation is included; keys and build binaries are not.

## Integration and release status

This source includes both new-capital buying and holdings-aware buy/sell execution. Research, contract execution, service deployment and observed trades are recorded separately in [the evidence ledger](docs/EVIDENCE.md). That ledger identifies the deployed policy version and the observations behind each claim; implementation is not mislabeled as missing merely because a recording is still pending.

The recorded model is `qwen3-32b` on Bricksum Kiln. The published Challenge A brief names `gpt-oss-120b`; organizer acceptance of this substitution has not been established by this repository. [Submission evidence and remaining items](docs/EVIDENCE.md) make the distinction explicit.

## Team

Built by members of **Blackstone**, a university blockchain collective.

| Name | Responsibility | University |
| --- | --- | --- |
| 조민석 | Backend | Seoul National University |
| 양주원 | Frontend | Chung-Ang University |
| 허운 | Smart contracts | Chung-Ang University |
| 제갈민 | Data analysis | Sungkyul University |

See [NOTICE.md](NOTICE.md) for the source, data and dependency boundaries.
