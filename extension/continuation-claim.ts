const owners = new WeakSet<object>();

// Tool/permission continuations must run while the original prompt is waiting
// for them, so they cannot use that prompt's queue. Claim before the first await
// instead; a duplicate caller must never replace the owner's response writer.
export async function claimContinuation(
  binding: object,
  work: () => Promise<void>,
  invalidate: () => Promise<void>,
): Promise<void> {
  if (owners.has(binding)) throw new Error("ACP continuation is already in progress for this session");
  owners.add(binding);
  try { await work(); }
  catch (error) {
    // A failed owner must not leave its server waiting for tools with a writer
    // that has already failed. Preserve the original error if cleanup also fails.
    try { await invalidate(); } catch { /* The durable in-flight marker remains unsafe to restore. */ }
    throw error;
  } finally { owners.delete(binding); }
}
