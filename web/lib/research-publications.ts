export type ResearchSection = {
  heading: string;
  paragraphs: readonly string[];
  points?: readonly string[];
};

export type ResearchReference = {
  label: string;
  href: string;
};

export type ResearchPublication = {
  slug: string;
  area: string;
  date: string;
  status: string;
  title: string;
  summary: string;
  question: string;
  finding: string;
  sections: readonly ResearchSection[];
  references: readonly ResearchReference[];
};

export const researchPublications: readonly ResearchPublication[] = [
  {
    slug: "compute-exchange-optimization-gates",
    area: "Compute markets",
    date: "September 2026",
    status: "Design note",
    title: "Optimizing for accepted work instead of GPU hours",
    summary: "A measurement framework for clearing heterogeneous capacity without turning raw rental price into the customer product.",
    question: "What should a compute exchange optimize when machines, deadlines, failure rates, and verification costs are all different?",
    finding: "The useful unit is cost per accepted work unit. GPU-hour price is only one supply input and cannot represent retry waste, backup capacity, verification, or settlement.",
    sections: [
      {
        heading: "The market unit",
        paragraphs: [
          "A buyer specifies the result, input, deadline, and maximum budget. The exchange chooses the hardware, provider, region, and shard plan. This keeps the customer contract stable while the supply mix changes underneath it.",
          "A quote must include primary capacity, backup capacity, verification, expected recovery cost, settlement, and the protocol fee. A cheap machine that produces expensive failures is not cheap capacity.",
        ],
      },
      {
        heading: "Deterministic clearing",
        paragraphs: [
          "The current planner design is intentionally bounded. Each source contributes at most 64 offers and an order contains at most 512 work quanta. Identical market snapshots must produce the same winner set and quote digest.",
        ],
        points: [
          "Equivalent offer permutations cannot change the economic result.",
          "Adding an eligible cheaper offer cannot raise the guaranteed price.",
          "Primary and backup allocations cover the work independently and cannot share a failure domain.",
          "Provider cost, verification reserve, and protocol fee conserve exact integer amounts.",
        ],
      },
      {
        heading: "Evidence boundary",
        paragraphs: [
          "The note separates modeled prices from measured production results. Public GPU offers can support a modeled clearing price, but they cannot prove realized savings, throughput, or deadline performance.",
          "Live claims remain gated on paid heterogeneous capacity, actual workload throughput, provider failure data, and Base settlement observations. Until those measurements exist, the system reports estimates as estimates.",
        ],
      },
    ],
    references: [
      { label: "Gavel: heterogeneity-aware cluster scheduling", href: "https://www.usenix.org/conference/osdi20/presentation/narayanan-deepak" },
      { label: "IBM Research: deadline-constrained spot bidding", href: "https://research.ibm.com/publications/optimal-bids-for-spot-vms-in-a-cloud-for-deadline-constrained-jobs" },
    ],
  },
  {
    slug: "flex-finality-prover-fabric",
    area: "Flex",
    date: "August 30, 2026",
    status: "Research report",
    title: "Clearing independent proving capacity without rebuilding the prover",
    summary: "A strict architecture for using Flex and third-party GPUs around Base-compatible SP1 clusters.",
    question: "Can Flex use independent GPU supply to reduce the capital and utilization risk of producing Base-compatible proofs?",
    finding: "Yes, if Flex clears whole-proof capacity across independent SP1 clusters and leaves the internal proof DAG to SP1 Cluster. Remote GPUs are supply; canonical proof acceptance remains the authority.",
    sections: [
      {
        heading: "What Flex contributes",
        paragraphs: [
          "The reviewed Flex assets already include bounded filter-score-reserve scheduling, epoch and fence semantics, idempotent receipts, deadline-aware optimization, content-addressed checkpoints, and fail-slow detection.",
          "Those mechanisms can decide which independent cluster receives a proof job, activate a backup when the primary misses a boundary, and preserve an auditable contribution record.",
        ],
      },
      {
        heading: "What Flex does not replace",
        paragraphs: [
          "SP1 Cluster already coordinates its CPU and GPU workers, artifacts, range proofs, aggregation, and wrapper stages. Rebuilding that inner DAG would add compatibility risk without improving the market boundary.",
          "The safer first market assigns complete proof jobs to independent clusters. Adjacent-range federation comes later, after exact-artifact, checkpoint, isolation, and multi-host recovery tests pass.",
        ],
      },
      {
        heading: "Rollout boundary",
        paragraphs: [
          "The research recommends three gates: whole-proof cluster auctions first, benchmark-gated range federation second, and permissionless edge GPUs only after security and operator-history gates.",
        ],
        points: [
          "Provider credentials and submission authority stay off untrusted workers.",
          "Primary and backup clusters must be operationally independent.",
          "The exact Base release, wrapper, SP1 version, ELF hashes, and verification keys travel together in one manifest.",
          "Payment becomes available only after the canonical verifier accepts the proof.",
        ],
      },
    ],
    references: [
      { label: "Base Beryl overview", href: "https://docs.base.org/base-chain/specs/upgrades/beryl/overview" },
      { label: "Base ZK prover specification", href: "https://docs.base.org/base-chain/specs/protocol/proofs/zk-prover" },
      { label: "SP1 Cluster", href: "https://github.com/succinctlabs/sp1-cluster" },
    ],
  },
  {
    slug: "exact-artifact-compatibility",
    area: "Base",
    date: "August 31, 2026",
    status: "Engineering evidence",
    title: "Recovering the exact active artifact before proof generation",
    summary: "How Skew recovered Base's active range program and independently checked it against the live verifier key.",
    question: "How can a prover know that its executable belongs to the artifact generation accepted by the live Base verifier?",
    finding: "Start from the verifier commitment, recover the corresponding public program object, derive its verification key independently, and fail closed unless the result matches the live key exactly.",
    sections: [
      {
        heading: "Recovery",
        paragraphs: [
          "Skew queried Succinct's public mainnet program-artifact lane with Base's active range verification key. The returned object decoded to a 33,249,320-byte RISC-V ELF with a content-addressed SHA-256 digest.",
          "Running SP1 setup over those bytes derived the exact range key committed by Base's live AggregateVerifier. A second derivation used the Base-selected Rust toolchain and SP1 6.3 in an independent Google Cloud build and produced the same key.",
        ],
      },
      {
        heading: "Why the direction matters",
        paragraphs: [
          "A branch name or dependency version is not acceptance authority. The live verifier key is. Searching backward from source guesses can produce plausible binaries that the verifier will never accept.",
          "The artifact-first path turns compatibility into a direct cryptographic check: exact bytes produce an exact key. Only then should a scheduler admit proof work for that artifact generation.",
        ],
      },
      {
        heading: "What remains open",
        paragraphs: [
          "Compatible bytes are not the same as reproducible source provenance. The exact source tree, guest lock, build invocation, and promotion record still need to reproduce the ELF byte-for-byte on independent builders.",
          "Current-range execution, wrapper generation, onchain acceptance, and proof economics are separate gates. The recovered artifact permits the next experiment; it does not turn an unrun proof into production evidence.",
        ],
      },
    ],
    references: [
      { label: "Base pull request 4393: proof image artifact flow", href: "https://github.com/base/base/pull/4393" },
      { label: "Base pull request 4768: artifact-generation routing", href: "https://github.com/base/base/pull/4768" },
      { label: "Public Succinct program artifact", href: "https://artifacts.mainnet.succinct.xyz/programs/artifact_01ky5h6j95er1txewz7ppbk1pd" },
    ],
  },
] as const;

export function getResearchPublication(slug: string) {
  return researchPublications.find((publication) => publication.slug === slug);
}
