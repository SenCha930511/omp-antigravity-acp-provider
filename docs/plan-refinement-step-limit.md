# Plan refinement and the official single-step text limit

The adapter reconstructs a cold ACP conversation from OMP system instructions,
historical messages and the latest user request. The latest request follows the
historical reference resource. This ordering is only safe when the complete
rendered input reaches the model.

The inspected official harness has `max_tokens_per_step = 64000`. Its trajectory
chat conversion checks each step and, on overflow, truncates the step to its first
`limit * 3` UTF-8 bytes, then adds a truncation notice. That is 192,000 bytes for
this configuration. The same conversion is used to construct model messages; it
is not merely a transcript-display limit. The raw conversation database can still
contain the complete input even though the converted model message is truncated.

## Adapter behavior

- Count text as rendered by the official ACP parser, including embedded-resource
  labels and separators. Treat images separately from textual base64.
- Reject above 188,000 rendered-text bytes, reserving 4,000 bytes below the observed
  official cutoff for request wrapping and metadata.
- Apply the guard to cold replay, warm deltas and single large user messages.
  Model-window and wire-budget overrides cannot disable it.
- Return `Maximum context length exceeded` before `session/prompt`. Never include
  conversation content in the error, silently omit history, or reorder an old
  question into the current request.

OMP can classify this error as context overflow and use its existing compaction
and retry pipeline. Its conventional summarizer can halve and repartition an
oversized window when it receives the same error. Those summaries are normal OMP
inference and depend on the user's compaction configuration; the adapter adds no
independent summary requests. A disabled compactor, an irreducible oversized user
message or oversized system instructions remain explicit errors.

The guard protects the inspected harness behavior; it does not negotiate a larger
server limit or change the advertised model window. Revisit it if the official
runtime changes its step conversion behavior.

## Offline verification

`npm run check` includes a built-runtime regression: an oversized replay of a
completed plan emits a context-overflow error without calling the fake ACP prompt
transport. Retrying with compacted decisions preserves both those decisions and
the newest refinement request. Unit tests also cover UTF-8, resource labels,
boundary sizing, large warm deltas and independent image budgets.

The optional `scripts/test-omp-compaction.ts` uses a local OMP source checkout's
actual `generateSummary` implementation with synthetic completions. In the
verified fixture, one oversized window was rejected, five smaller windows covered
all 60 messages, and the compacted refinement retained its new user question.
There are no model calls, user conversations or account identifiers in the fixture.
This validates the adaptive summary-window path, not a live Gemini or interactive
Refine plan end-to-end run.
