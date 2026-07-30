/**
 * The Gmail feature's public surface.
 *
 * The transport and the repositories are deliberately not exported: everything outside
 * this slice goes through the sync service.
 */

export { createSyncService, syncService } from './service/sync-service';
export type { SyncResult, SyncService } from './service/sync-service';

export {
  GmailAuthorizationError,
  GmailHistoryExpiredError,
  GmailMessageNotFoundError,
} from './client/gmail-transport';
export type { GmailTransport } from './client/gmail-transport';

export type { EmailProjection } from './domain/message';
