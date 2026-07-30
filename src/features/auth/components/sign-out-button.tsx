'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CSRF_HEADER } from '../csrf';
import { readCsrfToken } from '../read-csrf-token';

/**
 * Signs out by POSTing to /api/auth/logout with the CSRF token echoed from its cookie.
 *
 * A POST rather than a link, because signing out changes state — a GET logout can be
 * triggered by any image tag on any page.
 */
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { [CSRF_HEADER]: readCsrfToken() ?? '' },
      });
      // Replace rather than push, so Back does not return to an authenticated view.
      router.replace('/');
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className="border-border hover:bg-surface-muted rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
