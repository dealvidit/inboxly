/**
 * The auth feature's public surface.
 *
 * Other features and the app layer import from here. Repositories are deliberately not
 * exported: everything outside this slice goes through a service.
 */

export { getCurrentSession, requireCurrentSession } from './current-session';
export { COOKIE_NAMES } from './cookies';

export { authService } from './service/auth-service';
export {
  googleAccountService,
  createGoogleAccountService,
} from './service/google-account-service';
export { GoogleReauthRequiredError } from './service/google-oauth-client';
export {
  purgeExpiredSessions,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from './service/session-service';

export type {
  AuthenticatedSession,
  AuthenticatedUser,
  GmailConnection,
} from './domain/session';
export type { GoogleAccountService } from './service/google-account-service';
