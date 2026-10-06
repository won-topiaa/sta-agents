# Architecture

STA is a research system joined to an execution system by an immutable approval. It is not a language model with a wallet tool.

## 1. Research plane

`research-intake` extracts budget, horizon, target and universe from language, with optional selected stocks. Evidence strings ground numerical fields in the user's request. Missing information produces a draft requiring clarification, not invented funds or a trading permission.

`AgentStore` keeps owner-scoped strategies, versions, queued runs and execution steps in SQLite. Request IDs are bound to their request content. Worker leases carry fencing information so an expired worker cannot publish a late result over a newer run.

The deployed worker obtains up to three typed DSL designs from Kiln and launches the existing PR7 deterministic executor through `compute/design_bridge.py`, with a bounded environment, output size and timeout. Prices stay out of the model prompt. Training-only selection, held-out evaluation, future-data perturbation, doubled costs and lookback stability retain separate results and computation identities. The older small proposal path remains available only when the design bridge is explicitly disabled.

Evaluation separates a design interval from held-out history, calculates feasible long-only weights with cash and concentration bounds, and checks target support under normal and doubled costs. Signals at a close execute at a subsequent session, rather than trading retroactively at the price that generated them. The JavaScript audit checks candidate dimensions, units, limits and the derived decision independently. It is a second implementation of the boundary checks, not an independent audit organization or statistical certification.

## 2. Data plane

Collectors → ingestion versions → provenance/quality validation → content-addressed objects → sealed release → evaluator.

The pipeline preserves source identity, observation time, object hashes and coverage. A truncated refresh is not allowed to quietly replace substantially longer retained history. Known synthetic history is quarantined, not relabeled as real data. The publication removes unreachable random-walk generators and retains explicit failure guards.

There are two different prices: underlying equity history for research and the token execution price. Premium, share ratio, liquidity and cost observations mediate between them. A quoted token's atom count is not its dollar value or its number of underlying shares.

Limitations matter: retrospective adjusted prices can contain later corporate-action adjustments; a present-day universe has survivorship bias; Yahoo-backed paths are not independent vendors. A versioned store alone does not solve these issues. Raw datasets are excluded from this repository and the full-snapshot tests report skips when absent.

## 3. Approval plane

The report is a proposal. Selecting a candidate produces an integer allocation and a plan identity. Owner approval fixes the version, account, mint universe, budget, per-order bound, count and period. A later edit requires a different approval.

The user's wallet connection is not approval, and approval is not Start. A provisioned Privy binding must establish wallet ownership, the intended additional signer and an unchanged restrictive provider policy. Importing a customer's existing signing key is not part of this design.

## 4. Execution plane

The v2 controller accepts `NEW_CAPITAL` and `SELECTED_HOLDINGS_PLUS_NEW_CASH` allocations. It binds the agent wallet's actual holdings, puts sells before dependent buys, and asks StockMesh for exact held-mint liquidation or stock-purchase quotes. Before the signer is reachable, the gate checks:

1. Approved plan, actor, wallet and product mint agree.
2. Quote amount, one-product exposure and minimum output agree.
3. The decoded message uses the supported StockMesh opcode and allowed account/instruction shape.
4. Address-table resolution and source/destination token accounts agree with the message.
5. Network identity, exact-message simulation, fee budget and blockhash are acceptable.
6. A durable local reservation and the corresponding devnet reservation exist.
7. Approval, revocation and provider binding still match at signing time.

The exact-wire adapter is the new code. The older StockMesh router, pool implementations and exchange UI remain external. Publishing this adapter does not imply a new router deployment or liquidity for every catalog entry.

## 5. Recovery plane

```text
RESERVING → PERMITTED → SIGNING → SIGNED → UNKNOWN → RECONCILED
                           │                │             │
                           │                │             └─ devnet result record
                           │                └─ finalized error → FAILED_FINALIZED
                           └─ uncertain response → SIGNING_UNKNOWN
```

The journal uses SQLite WAL with `synchronous=FULL` and immediate write transactions. This is local crash persistence, not replicated high availability. One unresolved order fences the wallet across policy versions. The database is the single-writer coordination boundary; do not deploy multiple independent journals for the same delegated wallet.

`SIGNING_UNKNOWN` means the provider may have produced a signature. Do not re-sign or create a new quote automatically. `UNKNOWN` means the signed transaction may have landed. Retry only its exact bytes within the bounded relay allowance, then reconcile chain evidence. Elapsed time does not prove non-execution and cannot refund reserved spend.

A finalized success must match the exact signed wire, expected signature and fee, plus the wallet's source-token debit and destination-token credit. A finalized failure retains its actual network fee. Result recording happens after this classification, not after an HTTP 200.

## 6. Two chains, one explicit trust boundary

The 616-byte devnet policy account records owner, verifier, agent wallet, approval identity, budget, count and pending state. V1 contains eight inline mints. V2 replaces that list with a domain-separated ordered Merkle root covering up to 128 exact trade legs and 64 distinct stock mints. Each proof binds index, BUY/SELL side, mint, input quantity and minimum sale proceeds. SELL token quantities never increment the USDC reservation. Instructions initialize, reserve, settle and revoke. Reinitializing a PDA cannot reset counters. The verifier signs reservations and attestations; the owner controls initialization and revocation. See the evidence ledger for which version is deployed.

There is **no mainnet light client or cross-chain enforcement proof** in this program. Devnet cannot prevent a compromised authorized mainnet signer from spending. The isolated gate consumes its state and enforces the policy operationally. Settlement is an attestation about a mainnet observation, not a program independently replaying mainnet.

Mainnet/devnet/RPC failure therefore stops new execution. State regressions are rejected. This sacrifices availability rather than manufacturing certainty about funds.

## Read order

Start with [the runtime](../lib/research-autonomy-runtime.mjs), then [wire inspection](../lib/research-autonomy-wire.mjs), [the journal](../lib/research-autonomy-journal.mjs), [the policy program](../programs/xtxc-demo-policy/src/lib.rs) and [its SVM harness](../programs/xtxc-demo-policy/proof/src/main.rs). For research, start with [the evaluator](../compute/evaluate.py), [the backtest engine](../agent/xtxc_agent/research/backtest.py) and [strategy validation](../agent/xtxc_agent/research/strategy_lang.py).
