'use client';

import type { LayoutTemplateFitMode, LayoutTemplateOutline } from '@eticketsgo/web-kit';
import { templateSizeChoices } from '@/lib/layout-gallery';

/**
 * "How many seats?" for the template just chosen: exactly the planned number, or the nearest
 * full-row room below or above it. Shown under the gallery once a card is picked, so the number
 * that is built is the number the person chose - never "about" it.
 */
export function LayoutSizeChoice({
  outline,
  value,
  onChange,
  planned,
}: {
  outline: LayoutTemplateOutline | null;
  value: LayoutTemplateFitMode | null;
  onChange: (mode: LayoutTemplateFitMode) => void;
  planned: number;
}) {
  const choices = outline ? templateSizeChoices(outline) : [];
  if (choices.length === 0) return null;
  const chosen = value && choices.some((c) => c.mode === value) ? value : choices[0].mode;
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3" data-testid="size-choice">
      <legend className="px-1 text-sm font-semibold text-text-primary">
        How many seats? You planned {planned.toLocaleString()}.
      </legend>
      {choices.map((c) => (
        <label
          key={c.mode}
          className={`flex cursor-pointer items-start gap-2.5 rounded-md p-2 text-sm ${
            chosen === c.mode ? 'bg-tint-primary' : 'hover:bg-background-subtle'
          }`}
        >
          <input
            type="radio"
            name="layout-size"
            value={c.mode}
            checked={chosen === c.mode}
            onChange={() => onChange(c.mode)}
            className="mt-1 h-4 w-4 accent-action-primary"
          />
          <span>
            <span className="block font-medium text-text-primary">{c.label}</span>
            <span className="block text-caption text-text-secondary">{c.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The mode a choice resolves to when the person has not picked one: the first offered. */
export function defaultSizeMode(
  outline: LayoutTemplateOutline | null,
): LayoutTemplateFitMode | null {
  return outline ? (templateSizeChoices(outline)[0]?.mode ?? null) : null;
}
