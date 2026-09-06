'use client';

import { useQuery } from '@tanstack/react-query';
import { Monitor, Moon, Sun } from 'lucide-react';
import { api, useColorScheme, WorkspaceAccent, type ColorScheme } from '@eticketsgo/web-kit';
import { useActiveOrgId } from './org-context';

/**
 * Who this workspace belongs to, read from above the organization provider.
 *
 * Uses the same react-query key the provider does, so this is the cache, not a second
 * request. It has to live outside `OrgProvider` because the provider replaces its children
 * with a spinner while the list loads — useful inside the page, fatal for the header, which
 * would blank on every navigation.
 */
export function useWorkspace(): { name: string; logoUrl?: string | null; accent?: string | null } {
  const activeId = useActiveOrgId();
  const { data } = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: () => api.organizations.listMine(),
  });
  const org = data?.find((o) => o.id === activeId) ?? data?.[0];
  /*
    A neutral placeholder rather than "ETicketsGo" while the name is in flight. Painting the
    platform's name into the organizer's masthead and then swapping it a moment later is worse
    than a brief blank — it is the exact impression this header exists to remove.
  */
  return { name: org?.name ?? ' ', logoUrl: org?.logoUrl, accent: org?.consoleTheme };
}

/** Applies the organization's palette. Renders nothing. */
export function WorkspaceTheme() {
  const { accent } = useWorkspace();
  return <WorkspaceAccent accent={accent} />;
}

const OPTIONS: { value: ColorScheme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'Match system', Icon: Monitor },
];

/**
 * Light, dark, or whatever the machine is doing.
 *
 * Three states rather than a two-way toggle. A toggle has to decide what "off" means before
 * the person has expressed a preference, and whichever it picks is wrong for half of them;
 * "match system" is a real answer and it is the default.
 *
 * A segmented control rather than a dropdown because it is three short options that people
 * flip between, and because the current one should be readable without opening anything.
 */
export function ColorSchemeSwitch({ compact = false }: { compact?: boolean }) {
  const { scheme, setScheme } = useColorScheme();

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = scheme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setScheme(value)}
            className={`flex items-center gap-1.5 rounded px-2 py-1.5 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
              active
                ? 'bg-tint-primary text-action-primary'
                : 'text-text-muted hover:bg-background-subtle hover:text-text-primary'
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {!compact && <span className="hidden lg:inline">{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
