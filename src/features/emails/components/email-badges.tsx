import { Badge, type BadgeTone } from '@/components/ui/primitives';
import type { EmailCategory, Urgency } from '@/server/db';

/**
 * Presentation for the AI's judgements.
 *
 * Mapping enum → label and enum → colour lives here, in one place, so the list, the
 * detail view, and the filter chips cannot disagree about what CRITICAL looks like.
 */

const URGENCY_TONE: Record<Urgency, BadgeTone> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warning',
  CRITICAL: 'urgent',
};

const URGENCY_LABEL: Record<Urgency, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export function UrgencyBadge({ urgency }: { urgency: Urgency }) {
  return (
    <Badge tone={URGENCY_TONE[urgency]}>
      <span className="sr-only">Urgency: </span>
      {URGENCY_LABEL[urgency]}
    </Badge>
  );
}

const CATEGORY_LABEL: Record<EmailCategory, string> = {
  WORK: 'Work',
  PERSONAL: 'Personal',
  FINANCE: 'Finance',
  MEETING: 'Meeting',
  PROMOTION: 'Promotion',
  NEWSLETTER: 'Newsletter',
  NOTIFICATION: 'Notification',
  SUPPORT: 'Support',
  TRAVEL: 'Travel',
  SPAM: 'Spam',
  OTHER: 'Other',
};

export function CategoryBadge({ category }: { category: EmailCategory }) {
  return (
    <Badge tone="brand">
      <span className="sr-only">Category: </span>
      {CATEGORY_LABEL[category]}
    </Badge>
  );
}

export function categoryLabel(category: EmailCategory): string {
  return CATEGORY_LABEL[category];
}

/**
 * The model's self-reported confidence.
 *
 * Shown because a low-confidence classification is worth knowing about, and phrased as a
 * percentage with an explanatory title so it does not read as a precise measurement.
 */
export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const percentage = Math.round(confidence * 100);
  const tone: BadgeTone = confidence >= 0.8 ? 'neutral' : 'warning';

  return (
    <Badge tone={tone} title="How confident the model was in this analysis">
      {percentage}% confident
    </Badge>
  );
}
