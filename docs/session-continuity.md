# Session continuity invariants

Version 0.1.21 adds a versioned dispatch checkpoint to the adapter's session
registry. The model context window does not establish whether an ACP session's
accepted history matches OMP's retained transcript.

## Checkpoints

Persistent sessions acquire a cross-process lease before reading a mapping or
restoring ACP, and keep it while the warm runtime is alive. A competing runtime
fails explicitly until the owner shuts down or its idle runtime is retired. A
compromised lease closes the connection and invalidates its binding. Processes
running older adapter versions do not acquire this lease; restart them when upgrading.
The session registry rejects malformed or unknown-version records without writing
over them.

Adapter state follows OMP's active agent directory. Earlier releases stored all
profiles in the default agent directory. That existing directory remains intact;
named profiles and custom agent directories start with their own settings and
reconstruct their mappings from their retained OMP history on first use. Copy
specific settings files manually if needed; do not copy shared session mappings.

1. Validate the context and local transfer limits before changing the durable
   accepted boundary. A locally rejected prompt must not discard a known-good
   warm session.
2. Persist `ompCheckpointVersion: 1` and `ompInFlight: true` before dispatching
   `session/prompt`. If that write fails, do not send the prompt.
3. Recheck shutdown, invalidation and cancellation after the asynchronous write.
4. Clear the marker only with a successful terminal checkpoint or acknowledged
   cancellation whose retained output matches. A remotely completed turn whose
   final save fails remains unsafe to restore even if mapping removal also fails.
5. Reconstruct dirty and legacy mappings from retained OMP history. A legacy
   mapping has no proof that its stored boundary survived the last dispatch, so
   the migration intentionally rebuilds it once.

Unknown failures after dispatch invalidate the binding. Teardown closes the
transport even when registry operations fail. An invalidated turn cannot save its
mapping again. Conditional mapping removal avoids erasing a newer replacement.
Normal shutdown retains clean completed checkpoints.

## Tool and permission continuations

An active ACP prompt waits for its bridged tool/permission result. These
continuations cannot wait behind that prompt's queue without deadlocking. A
synchronous ownership claim instead allows one continuation to attach its writer
and release pending results. The claim ends after delivering that batch, before
waiting for the ACP prompt to finish, so subsequent tool/permission batches can
attach their own writers. An overlapping duplicate fails explicitly without
touching the owner's writer. Failed owner processing invalidates the old turn.

Missing tool/permission results invalidate the old binding before reconstruction;
reconnecting to the same saved session is not a repair for a divergent transcript.
The invalidation flag also prevents an old prompt that settles during teardown
from recreating the retired mapping.

## Assistant boundaries

The saved input prefix excludes the final generated assistant response, so that
response needs its own comparison. A changed retained response or missing
nonempty response forces reconstruction for normal completions as well as
cancellations. Empty normal completions use the same empty-text fingerprint that
the event writer emits. Unchanged completions retain warm reuse.

## Validation

`test/session-continuity.test.ts` exercises the built runtime with a fake ACP
transport and an in-memory store. It covers clean restoration, prompt failure,
pre-dispatch and terminal-save failure, failed removal, shutdown during a blocked
checkpoint, legacy migration, local size rejection, incomplete tools and
permissions, duplicate continuation ownership, successive and mixed continuation
batches within one prompt, and completed assistant edits,
removal and empty responses. Existing graceful-cancellation and cleanup
integration scripts remain required. These tests perform no model inference.
