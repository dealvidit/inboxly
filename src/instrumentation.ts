/**
 * Next.js runtime instrumentation.
 *
 * Runs once per server process, before any request. Used to register shutdown handlers
 * for the self-hosted case; the edge runtime has no process to signal, so it is skipped.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { registerShutdownHandlers } = await import('@/server/db/shutdown');
  registerShutdownHandlers();
}
