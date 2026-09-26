# Qoder history: bounded live-window reuse

## Contract

Live refreshes reuse a detached window only for the same file identity, size,
mtime, ctime and requested window size. Each display worker retains at most 16
windows / 32 MiB of encoded data. Larger windows still work through the existing
reader; they simply are not admitted to this cache.

New delivery receipts invalidate the window. Input-log acknowledgments and
receipt expiry are checked even on cache hits. Partial compaction restoration
and failed reads are never admitted. Older-history pagination and SDK branch
selection still use the existing full reader. Nothing is sent to an agent.

JSONL decoding now processes one physical line at a time. Append storage has at
most 8 MiB of spare capacity, counted in raw-cache accounting. Writes occur only
past the previous snapshot's byte view; rewrite/replacement/fresh receipt proof
uses new storage. Receipt hashes cover actual bytes, not spare capacity.

## Reproduction and evidence (2026-09-26)

Run in separate processes, with no other benchmark running:

```sh
node --expose-gc scripts/qoder-history-benchmark.mjs candidate tools 2310
```

The fixture is 304,710,417 bytes and contains no real conversation data. Compare
`candidate` at both code revisions: the script's `baseline` mode is a direct SDK
comparison, not old Codeck. Measurements below are one before/after run, not
production latency percentiles.

| Metric | Before (f3f74c0 + benchmark instrumentation) | After |
| --- | ---: | ---: |
| Cold ready | 2,230 ms | 2,375 ms |
| Open after another large history evicts raw cache | 1,448 ms | 2.5 ms |
| Records reparsed by that open | 9,252 | 0 |
| Three successive append reads | 591 / 587 / 554 ms | 564 / 119 / 110 ms |
| Sampled peak process RSS | 1,377 MiB | 1,318 MiB |

RSS includes the fixture driver and worker heaps; the small difference is not a
claim of a hard total-memory bound. The first append still expands/copies the
buffer; subsequent small appends reuse capacity. This change does not eliminate
full cold parsing, graph reconstruction on changed revisions, or full-prefix
hashing for delivery proofs. A single oversized raw transcript is still retained
by the existing raw-cache policy. A true indexed/paged reader is separate work.

Regression coverage includes raw-cache eviction, detached/bounded windows,
append/rewrite/replacement/deletion, pagination limits, unchanged-revision
compaction completion, late receipt registration, input-log-only acknowledgment,
malformed UTF-8 byte offsets and immutable snapshots during capacity reuse.
