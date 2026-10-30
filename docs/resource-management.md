# Resource management changes (0.1.20)

These changes extend the history/checkpoint optimizations in the Esc performance report and ship in npm/marketplace 0.1.20. They do not change the official ACP transport or guarantee Google cache hits.

## Correctness and concurrency

The outer tool projection uses the same bounded value-snapshot validation as structured fingerprints. Tool-array identity alone cannot authorize cache reuse. Mutating an array, descriptor or schema invalidates its projection, audit and prompt guidance; unsupported values recompute safely.

Catalog discovery and full refresh each use a single-flight promise. Failed work clears that promise for retry. A refreshed catalog uses the latest settings and replaces old upstream model entries instead of retaining removed models.

## Processes and disk

Each OMP process retains at most two idle runtime entries by default, plus any active entries. Idle eviction follows least-recent use and closes the ACP connection/bridge without removing its mapped disk session. `OMP_ACP_MAX_IDLE_RUNTIMES=0` disables this cap; the existing idle timeout remains independent.

Cleanup transactions, scans and removals use asynchronous filesystem calls. A shared promise queue serializes local operations and the existing cross-process lease lock protects deletion. Lifecycle bookkeeping is awaited; bulk collection after confirmation/release runs in the background. Failed lifecycle intentions retry on subsequent transactions and remain in memory only, bounded to 1024 entries. Malformed mappings, registries and unsafe paths fail closed.

Every mode protects saved OMP mappings and live leases. Only registered adapter-owned sessions can be removed. Soft count/byte limits default to disabled. Conservative/off modes warn when above budget. Timeout mode can additionally evict unmapped idle owned sessions in activity order, subject to a one-day default orphan grace for quota eviction. Protected entries can keep totals above budget. The default deletion batch is eight, with another batch after one second when work remains; periodic checks run every 15 minutes. Logical file bytes are not allocated disk usage. See README for commands and state-loss tradeoffs.

The optional `balanced` preset adds 7-day orphan retention, a minimum 1-day recovery window for confirmed replacements and final one-shot requests, and missing soft-budget defaults of 50 sessions/512 MiB. Orphan retention starts at the later of last activity and first observed absence of a mapping; newly unmapped old records are not immediately discarded. Pressure cannot shorten the recovery window. Existing policies stay unchanged. OMP's explicit final `releaseSession` hook now unmaps owned one-shot requests after teardown, preserving newer/ambiguous mappings and making the recovery copy eligible later. Generic close and reusable side conversations preserve mappings. The lifecycle remembers routing IDs across idle eviction and gates new requests through final unmapping.

## Packaging

The standalone bundle includes pinned upstream code, its unchanged supervisor and runtime manifest, and license notices. Build dependencies remain pinned development dependencies. Consumers need no production dependency tree. The marketplace launcher validates both bundled assets when the package advertises `ompAcpBundle: 1`, while accepting older published packages without that marker.

A clean macOS test installation measured:

| Item | Size |
| --- | ---: |
| npm tarball | 482,938 bytes |
| Unpacked file contents | 2,645,569 bytes |
| Allocated installation | 2,664 KiB |

The official Google runtime is downloaded separately and is excluded. Generated bundles and assets are not committed.

## Diagnostics and validation

Diagnostics default to off. At most 128 stage/duration samples stay in memory; only the enabled flag persists. No transcript, account or session identifiers are collected. Timings include local comparisons/checkpoints and separate ACP prompt/first-output/cancellation stages; full prompt time also includes inference and tools.

Offline regressions cover mutated tool projections, single-flight refresh failure recovery, idle LRU protection, cleanup mappings/leases/ownership, quotas/grace/batches, lifecycle retry and diagnostics bounds. Packed tests verify an isolated dependency-free consumer, supervisor startup and actual OMP catalog loading with ACP disabled.

Explicit Flash Low cancellation probes on 2026-10-21 covered both streamed text and a pending bridged tool. Both returned official `cancelled`, reused the same session without cold replay and answered the new request. Cancel-to-terminal took 9.857 ms and 8.711 ms; local follow-up dispatch took 2.875 ms and 2.298 ms. Total follow-up completion was 2.015 s and 3.045 s. These are two individual samples, not a paired speedup claim or an inference-latency guarantee. No Argon inference was used.
