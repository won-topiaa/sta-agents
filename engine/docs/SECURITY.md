# Trust boundary and failure behavior

This is a personal hackathon implementation, not an externally audited delegated-asset product. No key or wallet funding is needed to review it.

| Boundary | Rejection condition | Consequence |
| --- | --- | --- |
| User → research | Ungrounded budget, unsupported symbol, incomplete objective | Draft stays unapproved |
| Model → evaluator | Unknown fields, invalid enum, malformed JSON, missing usage | No executable proposal |
| Dataset → evaluator | Hash mismatch, expired/future/no-timezone manifest, invalid price, insufficient history | No eligible candidate |
| Result → approval | Unsafe weights, unsupported result, wrong owner/version | No execution plan |
| Provider → signer | Wrong app/owner/wallet, changed policy, extra authority | No signature request |
| Router → signer | Wrong mint/amount/receiver, changed message, unexpected instruction | No signature request |
| Journal → policy | Pending order, counter regression, changed approval | No replacement spend |
| RPC → receipt | Wrong cluster/wire/status/fee or missing token delivery | No delivered position |

## What the system trusts

The execution host, its journal, the enrolled provider policy and the authorized Privy signer remain trusted. The model never receives their credentials. RPC responses remain provider-observed evidence, not independently verified consensus proofs. A single server/database does not provide regional fault tolerance.

Devnet reservations are not mainnet limits. A devnet reset, unavailable verifier or changed state stops new execution; it does not prove that earlier mainnet effects vanished. Revocation checked before relay is not atomic with mainnet inclusion. A previously signed transaction may still land.

The current wire validator is deliberately narrow. BUY and SELL have distinct source/destination mint and receipt checks. Adding a new router instruction, mutable address-table behavior, authority shape or token program requires a new inspection/receipt specification and failure tests. Do not disable the validator to make a new route pass.

## Resource and process limits

The research worker bounds model responses, evaluator output and runtime; reserves inference budget before calling; and passes a restricted subprocess environment. The strategy DSL accepts data, not arbitrary generated Python. These are useful boundaries but not equivalent to a hostile-code VM. The reusable sandbox's stronger service/namespace mode must be configured separately; plain process mode is not advertised as full OS isolation.

Default tests inject providers or use local fixtures. Publication checks do not receive production credentials and run without network access where stated. No timer or trading service is activated by `npm test` or `pytest`.

## Report a problem

Open a private GitHub security report if available; otherwise contact **skewlabs@skew.deals** without including a key, access token or user database. Do not test vulnerabilities against live customer wallets. Reproduce with the fixture suites instead.
