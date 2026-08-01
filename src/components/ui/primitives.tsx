import type { ReactNode } from 'react';

/**
 * The handful of presentational primitives the dashboard actually uses.
 *
 * Deliberately small: these are the pieces that repeat across views, and nothing more.
 * A component library's worth of unused variants would be scaffolding, not architecture.
 */

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`border-border bg-surface rounded-[var(--radius-card)] border ${className}`}
    >
      {children}
    </div>
  );
}

/** Semantic colour for a badge, mapped from meaning rather than passed as a colour. */
export type BadgeTone = 'neutral' | 'brand' | 'urgent' | 'warning' | 'success' | 'info';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-ink-muted',
  brand: 'bg-brand-subtle text-brand',
  urgent: 'bg-urgent/10 text-urgent',
  warning: 'bg-warning/15 text-[color:oklch(45%_0.12_70)]',
  success: 'bg-success/10 text-success',
  info: 'bg-info/10 text-info',
};

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * An empty state.
 *
 * Always says what to do next, not just that there is nothing — an empty inbox view
 * during a first sync means something different from an empty search result.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="font-medium">{title}</p>
      <p className="text-ink-muted mx-auto mt-2 max-w-md text-sm">{description}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

/**
 * A loading placeholder.
 *
 * `aria-hidden` because it conveys nothing to a screen reader; the region it sits in
 * carries `aria-busy` instead.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`bg-surface-muted animate-pulse rounded ${className}`}
    />
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="border-ink-muted/30 border-t-ink-muted inline-block size-3.5 animate-spin rounded-full border-2"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * A determinate progress bar.
 *
 * Determinate on purpose: analysis has a known total, and "142 of 501" answers the
 * question a spinner leaves open — whether anything is happening, and how long it has
 * left. It carries the real ARIA progressbar semantics rather than a decorative div, so
 * the value is announced and not merely drawn.
 */
export function ProgressBar({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label: string;
}) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;

  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuetext={`${label}: ${value} of ${max}`}
      className="bg-surface-muted h-1.5 w-full overflow-hidden rounded-full"
    >
      <div
        className="bg-brand h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
