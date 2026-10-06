# Evidence, with its scope attached

An attractive result is not enough. A reviewer should be able to distinguish a model call, a numerical calculation, a contract fixture, a deployed program and an actual economic effect.

## Reproduced publication checks

The machine-readable result is [verification.json](../evidence/verification.json). It records suite counts and hashes of raw local test outputs. The tests run in an isolated workspace on the existing Linux host; JavaScript/Python execution has no network namespace access. This run does not spend tokens, contact a signer or send a transaction.

The publication adversarial suite covers:

* 28,800 combinations of active/revoked/pending state, budget, per-order size, count and permitted mint, compared with an independent arithmetic predicate.
* 10,000 allocations with totals above JavaScript's safe-integer range; every atom is conserved.
* Wallet-wide unresolved exposure after stopping one policy and registering another.
* Canonical hash stability under key ordering and sensitivity to every tested economic term.
* Future/no-timezone/oversized data manifests and invalid prices.

These finite domains do not constitute exhaustive verification of all programs or all possible states. The integer-allocation test is not a performance benchmark.

Some Python tests require privately retained full-universe/golden history. Their explicit skips are reported, not counted as passes. The source-only fixture suite does not establish current data coverage or investment performance.

## Historical provider observations

[kiln-observed.json](../evidence/kiln-observed.json) is an allowlisted extraction from an actual recorded test, not a new call during publication. It includes natural-language intake and proposal metering, prompt/response hashes, an ordinary `REVIEW` result and an extreme-target `DECLINED` result. The refusal record has no separate model trace and must not be counted as another measured inference.

The model was `qwen3-32b`, provider Bricksum Kiln. Latencies are individual observations, not p50/p99 measurements. Token accounting is not energy metering; no watt-hour claim is made.

## Historical on-chain observations

[devnet-observed.json](../evidence/devnet-observed.json) contains deployment and finalized policy initialization, reservation and revocation signatures. The program is [visible on devnet](https://explorer.solana.com/address/3i5oG6xw28CTDHf4q49MRxkr6z3uzvMwhtf9FK5qH4pr?cluster=devnet). Rejection cases marked `simulationOnly` are not landed transactions.

The reported deployed ELF matches the retained build hash. This is a historical deployment observation, not a guarantee that devnet state remains unchanged. No private deployment key or executable is published. The included SVM harness is a fixture execution environment; its CU observations, when run, apply to those instructions and accounts only.

## September 30 integration

The actual PR5 data and PR7 DSL executor are connected to the production research worker. The release builder previously intersected data with an older execution catalog, dropping eight already-collected symbols. The repaired release includes all 58 requested symbols plus GLD/MCD/MSFT reference data. ASML has 4,209 retained sessions.

Exact observations: [research integration](../evidence/research-integration-20260930.json), [compiled policy checks](../evidence/policy-v2-svm.json). The updated JavaScript suite passed 103/103 checks on the remote Linux host; the existing Rust unit suite passed 6/6. The web release build completed on that host. These counts do not stand in for funded acceptance.

One actual Chrome research run returned three Kiln/Qwen designs and a computed refusal: the requested 20% maximum drawdown was exceeded by the candidates. This is a completed provider/research observation, not a simulated trade.

V2 source adds exact ordered buy/sell commitments, agent-wallet holdings, sell-before-buy execution and direction-aware receipts. The compiled SBF passed 227 Mollusk checks, including JavaScript-to-SBF interoperability for 58 distinct stocks, mixed sells/buys, altered proofs/quantities/sides, replay and immutable budget state. These are local SVM checks, not on-chain signatures.

The V2 contract was upgraded at the same devnet address in finalized slot `505683774`. [The deployment observation](../evidence/devnet-v2-observed.json) binds the transaction signature to the program and SHA-256 `06bddfd62810eb89fec0cc58137209ed56aff911aac361a446a319c4501108dd`. The downloaded program matches all 86,672 ELF bytes, with only zero padding after them. The separately retained V1 entry above remains historical.

The new approval/holdings UI and isolated signing service were [promoted together](../evidence/service-integration-20260930.json). Existing wallet bindings, protected credentials and durable journals were retained. Research HTTP returned 200, signer health passed, and running policies remained zero. No approval, mainnet signature, funding or Start operation was performed by the deployment. A copied-directory read-permission failure was rolled back before promotion; the corrected release was then started successfully.

The public static-file mapping initially still pointed to the previous release. It now serves a union of both releases' immutable assets, preserving already-open tabs. Chrome subsequently restored the existing wallet session and saved research, and displayed all three actual PR7 candidates with their refusal reasons. This is UI/service evidence, not a wallet authorization or mainnet fill.

## Live acceptance ledger

1. A funded, approved autonomous mainnet order completing the entire STA path, with reconciled holdings and its final devnet result record. Existing manual XTXC trades are not substitute evidence.
2. A second changed-condition autonomous trade and a refused request tied to a complete demonstration recording.
3. V2 autonomous selling/rebalancing is implemented and exercised in contract tests; funded live acceptance is pending. Continuous discretionary portfolio management is a separate scope from an exact owner-approved allocation.
4. External audit, adversarial multi-provider consensus verification, multi-host durability and production latency/energy measurements.
5. Organizer acceptance of the observed Qwen model. The [published Challenge A brief](https://docs.google.com/document/d/13qh7oePGl7Flrl-Zh_A6hfr02L266PvS/edit) names `gpt-oss-120b`; the repository does not assert an approved substitution.

## Fast reviewer route

Read the [runtime](../lib/research-autonomy-runtime.mjs), then [its contract tests](../tests/research-autonomy.test.mjs). Follow an approval into [the controller](../lib/research-autonomy-control.mjs) and a reservation into [the Rust program](../programs/xtxc-demo-policy/src/lib.rs). Finally, compare a candidate's acceptance with [the deterministic evaluator](../compute/evaluate.py) and [its separate audit](../lib/research-evaluation-audit.mjs).

That path shows the architecture more directly than a diagram labeled “agentic” or a large line count.
