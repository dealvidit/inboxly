/**
 * The database module's public surface.
 *
 * Feature repositories import from here. Everything else must not — services and
 * routers go through a repository so that user scoping cannot be bypassed, and
 * eslint.config.mjs enforces that. See ADR 0008.
 */

export { db } from './client';
export { Prisma } from '@/generated/prisma/client';

export {
  AttemptOutcome,
  ConnectionStatus,
  EmailCategory,
  ProcessingStatus,
  Sentiment,
  SyncPhase,
  SyncStatus,
  SyncTrigger,
  Urgency,
} from '@/generated/prisma/enums';

/**
 * Row types, suffixed `Row` to keep them visibly distinct from the domain types that
 * repositories return. A `EmailRow` is a database record; an `Email` is a domain model.
 */
export type {
  AnalysisAttemptModel as AnalysisAttemptRow,
  EmailModel as EmailRow,
  EmailAnalysisModel as EmailAnalysisRow,
  GoogleAccountModel as GoogleAccountRow,
  SessionModel as SessionRow,
  SyncCheckpointModel as SyncCheckpointRow,
  SyncRunModel as SyncRunRow,
  UserModel as UserRow,
} from '@/generated/prisma/models';
