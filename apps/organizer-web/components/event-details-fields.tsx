'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button, Input, Select, Textarea, termsList, type EventArtist } from '@eticketsgo/web-kit';

/**
 * The details a buyer checks before paying: age limit, who is performing, and the terms.
 *
 * One component for the create wizard and the edit page, so both ask for the same things in
 * the same words and send them the same way. Controlled: the page owns the values and sends
 * them with the rest of the event.
 */
export interface EventDetailsValue {
  /** '' is "no age limit"; otherwise the minimum age as a string, from the select. */
  ageLimit: string;
  artists: EventArtist[];
  termsAndConditions: string;
}

export const EMPTY_EVENT_DETAILS: EventDetailsValue = {
  ageLimit: '',
  artists: [],
  termsAndConditions: '',
};

/** The ages events actually use. A select, because "18" typed as "81" is a real mistake. */
const AGE_LIMITS = [5, 12, 13, 15, 16, 18, 21];

/** How many performers the page shows. More than this is a festival line-up, not a card row. */
const MAX_ARTISTS = 20;

/** The stored event, as form values. */
export function eventDetailsFrom(event: {
  ageLimit?: number | null;
  artists?: EventArtist[] | null;
  termsAndConditions?: string | null;
}): EventDetailsValue {
  return {
    ageLimit: event.ageLimit == null ? '' : String(event.ageLimit),
    artists: (event.artists ?? []).map((a) => ({
      name: a.name,
      role: a.role ?? '',
      bio: a.bio ?? '',
    })),
    termsAndConditions: event.termsAndConditions ?? '',
  };
}

/**
 * The form values, as the API takes them.
 *
 * Sent explicitly even when empty (null, [] and ''), because on an edit an omitted field means
 * "leave it" - and an organizer who clears the age limit means "there is none now". Artists
 * with no name are dropped: a blank row is a row somebody added and did not fill in.
 */
export function eventDetailsBody(value: EventDetailsValue): {
  ageLimit: number | null;
  artists: EventArtist[];
  termsAndConditions: string;
} {
  return {
    ageLimit: value.ageLimit === '' ? null : Number(value.ageLimit),
    artists: value.artists
      .map((a) => ({
        name: a.name.trim(),
        ...(a.role?.trim() ? { role: a.role.trim() } : {}),
        ...(a.bio?.trim() ? { bio: a.bio.trim() } : {}),
      }))
      .filter((a) => a.name),
    termsAndConditions: value.termsAndConditions.trim(),
  };
}

export function EventDetailsFields({
  value,
  onChange,
  disabled,
}: {
  value: EventDetailsValue;
  onChange: (next: EventDetailsValue) => void;
  disabled?: boolean;
}) {
  const setArtist = (index: number, patch: Partial<EventArtist>) =>
    onChange({
      ...value,
      artists: value.artists.map((a, i) => (i === index ? { ...a, ...patch } : a)),
    });
  const terms = termsList(value.termsAndConditions);

  return (
    <fieldset className="space-y-4 rounded-md border border-border p-4" disabled={disabled}>
      <legend className="px-1 text-sm font-semibold">What buyers should know</legend>

      <Select
        label="Age limit"
        value={value.ageLimit}
        hint="Shown on the event page before anyone buys."
        onChange={(e) => onChange({ ...value, ageLimit: e.target.value })}
      >
        <option value="">No age limit</option>
        {AGE_LIMITS.map((age) => (
          <option key={age} value={String(age)}>
            {age}+
          </option>
        ))}
      </Select>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Artists and presenters</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || value.artists.length >= MAX_ARTISTS}
            onClick={() =>
              onChange({ ...value, artists: [...value.artists, { name: '', role: '', bio: '' }] })
            }
          >
            <Plus className="h-4 w-4" aria-hidden /> Add artist
          </Button>
        </div>
        {value.artists.length === 0 ? (
          <p className="text-caption text-text-muted">
            Optional. Add the performers, speakers or hosts buyers are coming to see.
          </p>
        ) : null}
        {value.artists.map((artist, index) => (
          <div key={index} className="space-y-2 rounded-md border border-border p-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Input
                label={`Artist ${index + 1} name`}
                value={artist.name}
                maxLength={80}
                onChange={(e) => setArtist(index, { name: e.target.value })}
              />
              <Input
                label="Role"
                value={artist.role ?? ''}
                maxLength={60}
                placeholder="Performer, Host, Speaker"
                onChange={(e) => setArtist(index, { role: e.target.value })}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove artist ${index + 1}`}
                onClick={() =>
                  onChange({ ...value, artists: value.artists.filter((_, i) => i !== index) })
                }
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <Input
              label="A line about them (optional)"
              value={artist.bio ?? ''}
              maxLength={300}
              onChange={(e) => setArtist(index, { bio: e.target.value })}
            />
          </div>
        ))}
      </div>

      <Textarea
        label="Terms and conditions"
        rows={5}
        maxLength={5000}
        value={value.termsAndConditions}
        placeholder={
          'Tickets cannot be exchanged.\nArrive 30 minutes before the show.\nRights of admission reserved.'
        }
        hint={
          terms.length
            ? `One per line. Buyers see ${terms.length} numbered term${terms.length === 1 ? '' : 's'}.`
            : 'One per line. Buyers see them as a numbered list on the event page.'
        }
        onChange={(e) => onChange({ ...value, termsAndConditions: e.target.value })}
      />
    </fieldset>
  );
}
