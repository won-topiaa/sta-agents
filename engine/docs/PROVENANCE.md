# Submission scope and provenance

## New repository, not a rewritten history

This repository is a curated source snapshot for **STA / Stock Token Agent**. It is not a rename of the older XTXC exchange, and its initial Git commit records publication time—not an invented development chronology.

The event participant guide states coding begins **28 September 2026, 19:00 KST**. The reviewed source files came from the September 28–30 research implementation and September 30 policy/execution integration. [source-provenance.json](../evidence/source-provenance.json) records original hashes, observed modification times, logical source labels and corresponding public hashes.

There was no complete committed history for these working copies. File modification times support snapshot chronology but **cannot prove original authorship or that every algorithm was first conceived during the event**. Judges can inspect what was copied and what changed; no timestamp has been backdated.

## Included

* Data collector source, quality gates and immutable-release construction—not paid/raw datasets.
* The Python research, evaluation, execution-cost and reporting library.
* Natural-language intake, typed Kiln proposals, token accounting and versioned approval storage.
* The exact-wire StockMesh adapter, approval controller, wallet binding and durable recovery state machine.
* The generic deployed devnet policy source, locked dependencies, tests and SVM harness.
* Sanitized public observations and new adversarial publication tests.

## Pre-existing or excluded

* [XTXC / StockMesh](https://github.com/xtxctrade/xtxc): existing mainnet router and exchange. Used through its API and supported instruction ABI; not submitted here as newly written router code.
* Archived exchange/mobile UI prototypes and vendored browser libraries.
* An earlier, undeployed mainnet mandate alternative. It is not the selected devnet-policy/mainnet-execution design.
* Production databases, personal wallet records, private endpoints, deployer keys, environment files, raw market data and generated build trees.

## Publication changes

The public copy removes unreachable synthetic-price generation bodies, makes evidence output portable, and prevents the local Python API from discovering a production credential directory by default. Each sandbox job captures a bounded, hashed catalog instead of discovering a server-global file. It also tightens dataset admission against future or timezone-free manifest timestamps, oversized manifests and malformed prices.

Added tests exhaust a 28,800-case policy grid, exercise 10,000 large-integer allocations, preserve a wallet fence across policy replacement and check approval digest sensitivity. These are deterministic property/contract checks, not a formal proof or live execution benchmark.

Cross-host verification exposed a few-ULP difference in derived float64 metrics. Golden comparisons use a documented `1e-12` tolerance for those summaries; the full published equity-curve hash and execution atom arithmetic remain exact. A separate test ensures a one-basis-point error still fails.

The on-chain Rust policy implementation is unchanged from the observed deployment source. The SVM harness only changes how its isolated artifact directory is selected. Public-copy changes were **not silently promoted to production**.

## Documentation references

The README structure was informed by [TigerBeetle's architecture explanation](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/ARCHITECTURE.md) and [Pydantic AI's project entry point](https://github.com/pydantic/pydantic-ai). The prose and diagrams here describe STA's own implementation; they do not claim either project's maturity, performance or endorsement.
