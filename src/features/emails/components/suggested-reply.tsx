'use client';

import { useState } from 'react';

/**
 * The AI's draft reply.
 *
 * Deliberately not sendable. Inboxly holds only `gmail.readonly`, so it *cannot* send —
 * and that is the design, not a limitation to work around: a draft the user copies into
 * Gmail keeps them in control of what goes out under their name.
 *
 * Rendered in a `pre`, never as HTML — this text originated from a model reading
 * attacker-controlled input.
 */
export function SuggestedReply({ reply }: { reply: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(reply);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the text is selectable either way.
      setCopied(false);
    }
  }

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Suggested reply</h3>
        <button
          type="button"
          onClick={copy}
          className="border-border hover:bg-surface-muted rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <pre className="border-border bg-surface-muted mt-2 rounded-lg border p-3 font-sans text-sm leading-relaxed whitespace-pre-wrap">
        {reply}
      </pre>

      <p aria-live="polite" className="sr-only">
        {copied ? 'Reply copied to clipboard' : ''}
      </p>

      <p className="text-ink-muted mt-2 text-xs">
        A draft for you to review. Inboxly has read-only access and cannot send mail.
      </p>
    </section>
  );
}
