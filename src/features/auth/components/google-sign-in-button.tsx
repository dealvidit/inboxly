/**
 * Sign-in entry point.
 *
 * A plain link, not a button with an onClick: starting the OAuth flow is a navigation,
 * so it should work without JavaScript, be middle-clickable, and show the browser's own
 * loading state. `rel="nofollow"` keeps crawlers out of the flow.
 */
export function GoogleSignInButton({
  returnTo,
  reconnect = false,
  label = 'Continue with Google',
}: {
  returnTo?: string;
  reconnect?: boolean;
  label?: string;
}) {
  const params = new URLSearchParams();
  if (returnTo) params.set('return_to', returnTo);
  if (reconnect) params.set('reconnect', '1');

  const query = params.toString();

  return (
    <a
      href={`/api/auth/google/start${query ? `?${query}` : ''}`}
      rel="nofollow"
      className="bg-brand text-on-brand hover:bg-brand-hover inline-flex items-center gap-3 rounded-lg px-5 py-3 text-sm font-medium transition-colors"
    >
      <GoogleMark />
      {label}
    </a>
  );
}

/** Google's mark, inlined so it needs no network request and no external asset. */
function GoogleMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#FFC107"
        d="M17.6 7.4h-8.6v3.2h4.9a5 5 0 0 1-4.9 3.6 5.2 5.2 0 0 1 0-10.4 5 5 0 0 1 3.3 1.3l2.3-2.3A8.4 8.4 0 0 0 9 .6a8.4 8.4 0 1 0 0 16.8c4.6 0 8.1-3.4 8.1-8.2 0-.6 0-1.2-.1-1.8Z"
      />
      <path
        fill="#FF3D00"
        d="M1.6 5.2 4.2 7.1A5 5 0 0 1 9 3.8a5 5 0 0 1 3.3 1.3l2.3-2.3A8.4 8.4 0 0 0 1.6 5.2Z"
      />
      <path
        fill="#4CAF50"
        d="M9 17.4a8.3 8.3 0 0 0 5.6-2.2l-2.6-2.2A5 5 0 0 1 4.3 11L1.7 13a8.4 8.4 0 0 0 7.3 4.4Z"
      />
      <path
        fill="#1976D2"
        d="M17.6 7.4H9v3.2h4.9a4.5 4.5 0 0 1-1.9 2.4l2.6 2.2a8.5 8.5 0 0 0 3.1-6c0-.6 0-1.2-.1-1.8Z"
      />
    </svg>
  );
}
