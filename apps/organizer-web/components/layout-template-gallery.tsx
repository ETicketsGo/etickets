'use client';

import { useQuery } from '@tanstack/react-query';
import { api, Skeleton, type LayoutTemplateOutline } from '@eticketsgo/web-kit';
import {
  LAYOUT_GALLERY,
  VENUE_TEMPLATES,
  type LayoutGalleryOption,
} from '@eticketsgo/shared-types';
import { templateBookable } from '@/lib/layout-gallery';
import { LayoutThumbnail } from './layout-thumbnail';

/**
 * The layout gallery: pick a starting point by what the room looks like.
 *
 * Each card states three things, because those are what somebody choosing actually weighs: a
 * picture of the room, how many it sells, and when to use it. The picture and the number are
 * both derived from the template's own geometry (`/seat-layout-templates`), never typed, so a
 * card cannot promise a room the template does not build.
 *
 * The seven owner-chosen cards come first. Templates that existed before the gallery (theatre,
 * amphitheatre, stadium, in the round) stay reachable under "More venue shapes", so nothing an
 * organizer could build before has disappeared.
 */

const STYLE_TAG: Record<LayoutGalleryOption['style'], string> = {
  GRID: 'Rows of seats',
  SECTIONED: 'Blocks on a venue map',
  GA: 'No seat map',
};

/** The templates the gallery does not feature, offered as plainer cards. */
const MORE: LayoutGalleryOption[] = VENUE_TEMPLATES.filter(
  (t) => !LAYOUT_GALLERY.some((g) => g.template === t.key),
).map((t) => ({
  id: t.key.toLowerCase(),
  label: t.label,
  sentence: t.description,
  // Every one of these is a sectioned venue; the cinema grid is featured above.
  style: 'SECTIONED',
  template: t.key,
}));

export interface LayoutTemplateGalleryProps {
  selectedId?: string | null;
  onChoose: (option: LayoutGalleryOption, outline: LayoutTemplateOutline | null) => void;
  /** Hidden where a GA choice has nothing to do, e.g. rebuilding an existing seated draft. */
  includeGeneralAdmission?: boolean;
}

export function LayoutTemplateGallery({
  selectedId,
  onChoose,
  includeGeneralAdmission = true,
}: LayoutTemplateGalleryProps) {
  const outlinesQ = useQuery({
    queryKey: ['layout-templates'],
    queryFn: () => api.theaterOps.layoutTemplates(),
    // The templates are the same for everybody and change only with a deploy.
    staleTime: Infinity,
  });
  const outlineFor = (option: LayoutGalleryOption) =>
    option.template ? (outlinesQ.data?.find((o) => o.key === option.template) ?? null) : null;

  const featured = LAYOUT_GALLERY.filter((g) => includeGeneralAdmission || g.style !== 'GA');

  const card = (option: LayoutGalleryOption) => {
    const outline = outlineFor(option);
    const on = selectedId === option.id;
    const capacity =
      option.style === 'GA'
        ? 'You set how many tickets to sell'
        : outline
          ? `${templateBookable(outline).toLocaleString()} seats`
          : null;
    return (
      <button
        key={option.id}
        type="button"
        aria-pressed={on}
        data-testid={`template-${option.id}`}
        onClick={() => onChoose(option, outline)}
        className={`flex h-full flex-col gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
          on ? 'border-action-primary bg-tint-primary' : 'border-border hover:bg-background-subtle'
        }`}
      >
        {outlinesQ.isPending && option.style !== 'GA' ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <LayoutThumbnail
            outline={outline}
            label={option.label}
            generalAdmission={option.style === 'GA'}
          />
        )}
        <span className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="text-sm font-semibold text-text-primary">{option.label}</span>
          {capacity ? (
            <span className="text-caption tabular-nums text-text-secondary">{capacity}</span>
          ) : null}
        </span>
        <span className="text-caption leading-snug text-text-muted">{option.sentence}</span>
        <span className="mt-auto text-caption font-medium text-text-secondary">
          {STYLE_TAG[option.style]}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-3">
      {outlinesQ.isError ? (
        <p role="alert" className="text-caption text-status-error">
          We could not load the template pictures. You can still choose one.
        </p>
      ) : null}
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="layout-gallery"
      >
        {featured.map((option) => card(option))}
      </div>
      {MORE.length > 0 ? (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer select-none px-3 py-2 text-caption font-medium text-text-secondary">
            More venue shapes ({MORE.length})
          </summary>
          <div className="grid grid-cols-1 gap-3 border-t border-border p-3 sm:grid-cols-2">
            {MORE.map((option) => card(option))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
