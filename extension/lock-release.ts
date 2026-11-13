export async function releaseAfter(
  release: () => Promise<void>,
  primaryFailed: boolean,
  compromised?: Error,
): Promise<void> {
  try {
    await release();
  } catch (error) {
    if (!primaryFailed) throw compromised ?? error;
    return;
  }
  if (!primaryFailed && compromised) throw compromised;
}
