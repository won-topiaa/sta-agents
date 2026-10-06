# Review and controlled execution

## Offline review

Start with the commands in [README](../README.md). The fixture suites require no wallet, RPC or model credentials. Dependencies are pinned in `package-lock.json`, `requirements.txt` and the two Cargo lockfiles.

On Linux, run tests under `sudo unshare -n -- ...` to remove outbound network access. Install dependencies before entering the namespace. Set `XTXC_CATALOG_REPORT` to the included historical catalog fixture and `XTXC_DATA_DIR` to an empty isolated directory. Do not point tests at a production journal or private credential directory.

## SVM fixture harness

The harness at `programs/xtxc-demo-policy/proof` runs the compiled policy in Mollusk. It expects `STA_SVM_ROOT/sbf/xtxc_demo_policy.so` and an existing `STA_SVM_ROOT/evidence` directory.

```sh
mkdir -p .local/svm/sbf .local/svm/evidence
cargo build-sbf --manifest-path programs/xtxc-demo-policy/Cargo.toml --sbf-out-dir .local/svm/sbf
STA_SVM_ROOT="$PWD/.local/svm" node scripts/policy-v2-vectors.mjs
STA_SVM_ROOT="$PWD/.local/svm" cargo run --locked --manifest-path programs/xtxc-demo-policy/proof/Cargo.toml
```

Install a compatible Solana/Agave SBF toolchain separately. A source-only checkout does not include the historical ELF or its build keypair. Native Rust tests do not run SBF, and an SVM fixture pass is not a devnet deployment.

## Research with a real provider

Keep keys in a private environment, never in committed files. `.env.example` lists the research inputs. Review the model endpoint, catalog and dataset manifest before any paid call. `worker:once` processes one queued run; it does not grant trade authority.

`scripts/research-agent-evidence.mjs` is an opt-in, paid-model research check. It only accepts an absolute subdirectory of `.local/evidence` for its output and writes a separate SQLite store. It does not import a wallet signer or RPC transport. Do not run it merely to reproduce the offline tests.

The collectors need optional packages `yfinance`, `arcticdb` and `pyarrow` in addition to the core requirements. Review source access and rights before installing/running collectors. Their raw output is not a redistributable fixture. There is no default refresh daemon in this public package.

## Execution integration

Deployment of `research-wallet-service` and `research-autonomy-service` requires deliberate configuration of authenticated upstream callers, Unix-socket permissions, isolated state directories, Privy authorization and network bindings. These service entry points are included for inspection, not started by setup or CI. The XTXC frontend/server routes remain outside this source snapshot.

Follow this order in a separately authorized environment:

1. Verify the source release, authenticated owner and current StockMesh API/ABI.
2. Enroll an agent-wallet binding with the intended provider policy; wallet connection does not start trading.
3. Approve a particular strategy version and the generic devnet policy. Fund only the intended wallet under an explicit budget.
4. Use the owner's explicit Start action. Persist reservation before any signer request.
5. Reconcile exact mainnet receipt and holdings, then record its result commitment on devnet.
6. If any state is uncertain, preserve the unresolved fence and investigate. Never reset a journal or allowance to make the UI proceed.

This publication does not authorize a deployment, transfer, autonomous order or trading timer.
