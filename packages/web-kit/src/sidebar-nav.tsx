'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, CornerDownLeft, Search, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  activeSectionIndex,
  filterQuickNav,
  navCurrentHref,
  navInSection,
  navSections,
  quickNavEntries,
  type NavItem,
  type NavSection,
} from './nav';

/*
  ── ONE NAVIGATION, BOTH CONSOLES ─────────────────────────────────────────────────────
  The organizer and admin consoles had two sidebars built twice: one flat list with optional
  headings, one with foldable groups and its own rail. They looked alike and behaved
  differently - a rail of anonymous icons on one, every group open on the other, a scroll bar
  inside a scroll bar on both - and the owner scored the result 5/10 and 4/10.

  Everything here is shared, so the two consoles cannot drift again:

  - Groups fold, and only the one holding the current page starts open. Nine admin groups
    of three links each used to be twenty-five rows; now it is nine headings and the three
    rows you are working in, which fits a 768px-tall laptop without a second scroll bar.
  - "Find a page" (and Ctrl or Cmd + K) finds any page the viewer may open, by name.
  - The collapsed rail shows one button per GROUP, each with a tooltip on hover and on
    focus and a flyout listing that group's pages by name. A rail of thirty unlabelled icons
    is a memory test; a rail of nine named groups is a menu.

  Visibility is UX, never authorization: the shell is handed the nav AFTER `visibleNav`
  removed what the viewer cannot open, and every route keeps its own guard.
*/

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
/** Inside the navy sidebar and drawer the ring is the light teal, which reads on navy. */
const NAV_FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-accent';

/** "Ctrl K" or "⌘ K" in words a screen reader can say; decided after mount. */
function useShortcutLabel(): { visual: string; spoken: string } {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);
  return mac ? { visual: 'Cmd K', spoken: 'Command K' } : { visual: 'Ctrl K', spoken: 'Control K' };
}

/** The visible search field at the top of the sidebar and the drawer. It opens quick nav. */
export function QuickNavTrigger({
  onOpen,
  compact,
  tone = 'surface',
}: {
  onOpen: () => void;
  compact?: boolean;
  /** `surface` in the top bar; `nav` on the navy of the phone drawer. */
  tone?: 'surface' | 'nav';
}) {
  const key = useShortcutLabel();
  if (compact) {
    return (
      <RailTip label={`Find a page (${key.visual})`}>
        {(tip) => (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Find a page, ${key.spoken}`}
            aria-keyshortcuts="Control+K Meta+K"
            {...tip}
            className={`flex h-10 w-10 items-center justify-center rounded-md text-text-secondary transition-colors duration-150 hover:bg-background-subtle hover:text-text-primary ${FOCUS}`}
          >
            <Search className="h-[1.125rem] w-[1.125rem]" aria-hidden />
          </button>
        )}
      </RailTip>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-keyshortcuts="Control+K Meta+K"
      className={`group flex h-10 w-full items-center gap-2.5 rounded-md border px-3 text-left text-ui transition-colors duration-150 ${
        tone === 'nav'
          ? `border-nav-border bg-nav-hover text-nav-foreground hover:border-nav-muted ${NAV_FOCUS}`
          : `border-border bg-background-canvas text-text-muted hover:border-border-input hover:text-text-secondary ${FOCUS}`
      }`}
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1 truncate">Find a page</span>
      <kbd
        className={`hidden rounded border px-1.5 py-0.5 font-sans text-[0.6875rem] font-medium sm:inline ${
          tone === 'nav'
            ? 'border-nav-border bg-nav text-nav-muted'
            : 'border-border bg-background-surface text-text-muted'
        }`}
        aria-hidden
      >
        {key.visual}
      </kbd>
      <span className="sr-only">, {key.spoken}</span>
    </button>
  );
}

/**
 * The expanded tree: folding groups, each holding its items and their secondary pages.
 *
 * Group open state: the group holding the current page is open; every other group is closed
 * until somebody opens it. A group somebody opened stays open while they move around, and
 * arriving on a page opens its group whatever was folded before, so the current page is
 * never hidden inside a closed heading.
 */
export function NavTree({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  const sections = useMemo(() => navSections(items), [items]);
  const current = navCurrentHref(pathname, items);
  const active = activeSectionIndex(pathname, sections);
  const activeLabel = active >= 0 ? sections[active].label : undefined;
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [kidsOpen, setKidsOpen] = useState<Record<string, boolean>>({});
  const baseId = useId();

  // Landing on a page opens its group, even one the person folded earlier.
  useEffect(() => {
    if (activeLabel) setGroupOpen((s) => (s[activeLabel] ? s : { ...s, [activeLabel]: true }));
  }, [activeLabel]);

  const link = (item: NavItem, depth: 0 | 1) => {
    const isCurrent = item.href === current;
    const isSection = !isCurrent && depth === 0 && navInSection(pathname, item);
    const Icon = item.icon;
    return (
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={isCurrent ? 'page' : undefined}
        className={`group/link relative flex min-h-[2.75rem] min-w-0 flex-1 items-center gap-3 rounded-md px-3 transition-colors duration-150 lg:min-h-[2.375rem] ${NAV_FOCUS} ${
          depth === 1 ? 'text-[0.8125rem]' : 'text-ui'
        } ${
          isCurrent
            ? 'bg-nav-active font-semibold text-nav-active-foreground'
            : isSection
              ? 'font-semibold text-white hover:bg-nav-hover'
              : 'text-nav-foreground hover:bg-nav-hover hover:text-white'
        }`}
      >
        {isCurrent && (
          // A bar as well as the tint: the current page is told apart by shape, not colour alone.
          <span
            className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-nav-accent"
            aria-hidden
          />
        )}
        {Icon && depth === 0 && (
          <Icon
            className={`h-[1.125rem] w-[1.125rem] shrink-0 ${
              isCurrent ? 'text-nav-accent' : 'text-nav-muted group-hover/link:text-nav-foreground'
            }`}
            aria-hidden
          />
        )}
        <span className="truncate">{item.label}</span>
      </Link>
    );
  };

  const list = (section: NavSection, listId: string, hidden: boolean) => (
    <ul id={listId} hidden={hidden} className="space-y-0.5 pb-1">
      {section.items.map((item) => {
        const kids = item.children ?? [];
        const open = kidsOpen[item.href] ?? navInSection(pathname, item);
        const kidsId = `${listId}-${item.href.replace(/[^a-z0-9]/gi, '-')}`;
        return (
          <li key={item.href}>
            <div className="flex items-center gap-0.5">
              {link(item, 0)}
              {kids.length > 0 && (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={kidsId}
                  aria-label={`${open ? 'Hide' : 'Show'} more ${item.label} pages`}
                  onClick={() => setKidsOpen((s) => ({ ...s, [item.href]: !open }))}
                  className={`flex h-11 w-9 shrink-0 items-center justify-center rounded-md text-nav-muted transition-colors duration-150 hover:bg-nav-hover hover:text-white lg:h-[2.375rem] ${NAV_FOCUS}`}
                >
                  <ChevronDown
                    className={`h-4 w-4 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
                    aria-hidden
                  />
                </button>
              )}
            </div>
            {kids.length > 0 && open && (
              <ul
                id={kidsId}
                className="mb-1 ml-[1.45rem] mt-0.5 space-y-0.5 border-l border-nav-border pl-2"
              >
                {kids.map((kid) => (
                  <li key={kid.href} className="flex">
                    {link(kid, 1)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-1">
      {sections.map((section, si) => {
        const listId = `${baseId}-g${si}`;
        if (!section.label) return <div key={`s${si}`}>{list(section, listId, false)}</div>;
        const open = groupOpen[section.label] ?? si === active;
        const isActive = si === active;
        return (
          <div key={section.label}>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setGroupOpen((s) => ({ ...s, [section.label!]: !open }))}
              className={`flex h-11 w-full items-center justify-between gap-2 rounded-md px-3 text-left text-micro font-semibold uppercase tracking-[0.05em] transition-colors duration-150 hover:bg-nav-hover hover:text-white lg:h-[1.875rem] ${NAV_FOCUS} ${
                isActive ? 'text-nav-foreground' : 'text-nav-muted'
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{section.label}</span>
                {isActive && !open && (
                  // Folded with the current page inside: say so, so it is not lost.
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-nav-accent" aria-hidden />
                )}
              </span>
              <ChevronRight
                aria-hidden
                className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
              />
            </button>
            {list(section, listId, !open)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A tooltip for the rail: shown on hover AND on keyboard focus, beside the control.
 *
 * Visual only (`aria-hidden`): the control it describes already carries the same words as
 * its accessible name, and a screen reader hearing them twice is noise. Positioned `fixed`
 * from the trigger's own rectangle, because the rail scrolls and clips its overflow, and a
 * tooltip inside it would be cut off at the rail's edge.
 */
export function RailTip({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: (props: {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave: () => void;
    onFocus: (e: React.FocusEvent<HTMLElement>) => void;
    onBlur: () => void;
  }) => ReactNode;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ top: r.top + r.height / 2, left: r.right + 10 });
  };
  const hide = () => setAt(null);
  // A scroll moves the trigger out from under a fixed tooltip; hide rather than mislead.
  useEffect(() => {
    if (!at) return;
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [at]);
  return (
    <>
      {children({
        onMouseEnter: (e) => show(e.currentTarget),
        onMouseLeave: hide,
        onFocus: (e) => {
          // Keyboard focus only: a click also focuses, and would leave a tooltip on screen.
          if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget);
        },
        onBlur: hide,
      })}
      {at && !disabled && (
        <span
          aria-hidden
          data-rail-tooltip=""
          style={{ top: at.top, left: at.left }}
          className="pointer-events-none fixed z-50 -translate-y-1/2 whitespace-nowrap rounded-md bg-text-primary px-2.5 py-1.5 text-[0.8125rem] font-medium text-background-surface shadow-md"
        >
          {label}
        </span>
      )}
    </>
  );
}

/**
 * The collapsed rail: a button per group, opening a flyout of that group's pages by name.
 *
 * Disclosure semantics (`aria-expanded` + `aria-controls`), not a menu: the flyout holds
 * ordinary links, so Tab walks into it from its button and Escape hands focus back. Arrow
 * Right opens it and lands on the first link, which is where somebody who has used a
 * desktop menu bar expects to go. Items listed outside any group (check-in staff have two
 * pages and no groups) are links straight in the rail, each with its tooltip.
 */
export function NavRail({ items, pathname }: { items: NavItem[]; pathname: string }) {
  const sections = useMemo(() => navSections(items), [items]);
  const current = navCurrentHref(pathname, items);
  const active = activeSectionIndex(pathname, sections);
  const [open, setOpen] = useState<{ index: number; top: number; left: number } | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const flyout = useRef<HTMLDivElement>(null);
  const baseId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen((o) => {
      if (o && refocus) buttons.current[o.index]?.focus();
      return null;
    });
  }, []);

  const openAt = (index: number, focusFirst: boolean) => {
    const el = buttons.current[index];
    if (!el) return;
    const r = el.getBoundingClientRect();
    setOpen({ index, top: r.top, left: r.right + 8 });
    if (focusFirst) {
      requestAnimationFrame(() => flyout.current?.querySelector<HTMLElement>('a[href]')?.focus());
    }
  };

  // A route change is a navigation; the flyout has done its job.
  useEffect(() => setOpen(null), [pathname]);

  // Outside click and Escape close it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (flyout.current?.contains(t) || buttons.current[open.index]?.contains(t)) return;
      setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Keep the flyout on screen: a group near the bottom of a short window opens upwards.
  const [shift, setShift] = useState(0);
  useEffect(() => {
    if (!open || !flyout.current) return setShift(0);
    const h = flyout.current.offsetHeight;
    const overflow = open.top + h - (window.innerHeight - 12);
    setShift(overflow > 0 ? Math.min(overflow, open.top - 12) : 0);
  }, [open]);

  const onButtonKey = (index: number) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      openAt(index, true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Move between groups like a toolbar, so the rail is quick to walk with arrows too.
      e.preventDefault();
      const list = buttons.current.filter(Boolean) as HTMLButtonElement[];
      const at = list.indexOf(e.currentTarget);
      const next = list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
      next?.focus();
    }
  };

  const onFlyoutKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const links = Array.from(flyout.current?.querySelectorAll<HTMLElement>('a[href]') ?? []);
    const at = links.indexOf(document.activeElement as HTMLElement);
    const next = links[(at + (e.key === 'ArrowDown' ? 1 : links.length - 1)) % links.length];
    next?.focus();
  };

  return (
    <ul className="flex flex-col items-center gap-1">
      {sections.map((section, si) => {
        if (!section.label) {
          return section.items.map((item) => {
            const Icon = item.icon;
            const isCurrent = navInSection(pathname, item);
            return (
              <li key={item.href}>
                <RailTip label={item.label}>
                  {(tip) => (
                    <Link
                      href={item.href}
                      aria-label={item.label}
                      aria-current={item.href === current ? 'page' : undefined}
                      {...tip}
                      className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors duration-150 ${NAV_FOCUS} ${
                        isCurrent
                          ? 'bg-nav-active text-nav-accent'
                          : 'text-nav-muted hover:bg-nav-hover hover:text-white'
                      }`}
                    >
                      {Icon && <Icon className="h-[1.125rem] w-[1.125rem]" aria-hidden />}
                    </Link>
                  )}
                </RailTip>
              </li>
            );
          });
        }
        const Icon = section.icon;
        const isOpen = open?.index === si;
        const isActive = si === active;
        const flyoutId = `${baseId}-f${si}`;
        return (
          <li key={section.label}>
            <RailTip label={section.label} disabled={isOpen}>
              {(tip) => (
                <button
                  type="button"
                  ref={(el) => {
                    buttons.current[si] = el;
                  }}
                  aria-label={isActive ? `${section.label}, current section` : section.label}
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? flyoutId : undefined}
                  onClick={() => (isOpen ? close(false) : openAt(si, false))}
                  onKeyDown={onButtonKey(si)}
                  {...tip}
                  className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors duration-150 ${NAV_FOCUS} ${
                    isActive
                      ? 'bg-nav-active text-nav-accent'
                      : isOpen
                        ? 'bg-nav-hover text-white'
                        : 'text-nav-muted hover:bg-nav-hover hover:text-white'
                  }`}
                >
                  {Icon && <Icon className="h-[1.125rem] w-[1.125rem]" aria-hidden />}
                </button>
              )}
            </RailTip>
            {isOpen && (
              <div
                ref={flyout}
                id={flyoutId}
                role="group"
                aria-label={section.label}
                onKeyDown={onFlyoutKey}
                style={{ top: open.top - shift, left: open.left }}
                className="fixed z-50 max-h-[calc(100dvh-1.5rem)] w-64 overflow-y-auto rounded-lg border border-border bg-background-elevated p-2 shadow-lg [scrollbar-width:thin] motion-safe:animate-scale-in"
              >
                <p className="px-2 pb-1.5 pt-1 text-[0.75rem] font-semibold uppercase tracking-[0.06em] text-text-muted">
                  {section.label}
                </p>
                <ul className="space-y-0.5">
                  {section.items.flatMap((item) => [
                    <li key={item.href}>
                      <FlyoutLink item={item} current={current} indent={false} />
                    </li>,
                    ...(item.children ?? []).map((kid) => (
                      <li key={kid.href}>
                        <FlyoutLink item={kid} current={current} indent />
                      </li>
                    )),
                  ])}
                </ul>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FlyoutLink({
  item,
  current,
  indent,
}: {
  item: NavItem;
  current: string | null;
  indent: boolean;
}) {
  const Icon = item.icon;
  const isCurrent = item.href === current;
  return (
    <Link
      href={item.href}
      aria-current={isCurrent ? 'page' : undefined}
      className={`flex min-h-[2.25rem] items-center gap-2.5 rounded-md px-2 text-[0.875rem] transition-colors duration-150 ${FOCUS} ${
        indent ? 'pl-8 text-[0.8125rem]' : ''
      } ${
        isCurrent
          ? 'bg-tint-primary font-semibold text-action-primary'
          : 'text-text-secondary hover:bg-background-subtle hover:text-text-primary'
      }`}
    >
      {Icon && !indent && <Icon className="h-4 w-4 shrink-0" aria-hidden />}
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/**
 * Quick navigation: type a few letters of any page's name and go there.
 *
 * A combobox over a listbox (the ARIA 1.2 pattern): focus stays in the field, arrows move the
 * highlighted option, Enter opens it, Escape closes and hands focus back to whatever opened
 * it. It lists only the pages in the nav it was given - which is the viewer's nav, already
 * filtered - so it can never offer a page that would refuse them.
 */
export function QuickNav({
  items,
  open,
  onClose,
}: {
  items: NavItem[];
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const entries = useMemo(() => quickNavEntries(items), [items]);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const baseId = useId();
  const results = useMemo(() => filterQuickNav(entries, query), [entries, query]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setIndex(0);
    requestAnimationFrame(() => input.current?.focus());
    return () => {
      opener.current?.focus?.();
    };
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  // Keep the highlighted option in view as the arrows move it.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${baseId}-o${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, open, baseId]);

  if (!open) return null;

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[index];
      if (hit) go(hit.href);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      // The dialog has one control; Tab must not escape to the page behind it.
      e.preventDefault();
    }
  };

  const listId = `${baseId}-list`;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-4 pt-[12vh] motion-safe:animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Find a page"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-background-elevated shadow-lg motion-safe:animate-scale-in"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? `${baseId}-o${index}` : undefined}
            aria-label="Page name"
            placeholder="Type a page name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            className="h-14 min-w-0 flex-1 bg-transparent text-[1rem] text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-background-subtle hover:text-text-primary ${FOCUS}`}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <ul
          id={listId}
          role="listbox"
          aria-label="Pages"
          className="max-h-[min(24rem,60vh)] overflow-y-auto p-2 [scrollbar-width:thin]"
        >
          {results.map((r, i) => {
            const Icon = r.icon;
            const selected = i === index;
            return (
              <li
                key={r.href}
                id={`${baseId}-o${i}`}
                role="option"
                aria-selected={selected}
                onMouseMove={() => setIndex(i)}
                onClick={() => go(r.href)}
                className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 ${
                  selected ? 'bg-tint-primary' : ''
                }`}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                    selected
                      ? 'bg-background-surface text-action-primary'
                      : 'bg-background-subtle text-text-secondary'
                  }`}
                  aria-hidden
                >
                  {Icon && <Icon className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-[0.9375rem] font-medium ${
                      selected ? 'text-action-primary' : 'text-text-primary'
                    }`}
                  >
                    {r.label}
                  </span>
                  {r.trail && (
                    <span className="block truncate text-caption text-text-muted">{r.trail}</span>
                  )}
                </span>
                {selected && (
                  <CornerDownLeft className="h-4 w-4 shrink-0 text-action-primary" aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
        {results.length === 0 && (
          <p className="px-5 pb-5 pt-1 text-[0.9375rem] text-text-muted" role="status">
            No page matches &quot;{query}&quot;. Pages you do not have access to are not listed.
          </p>
        )}
        <p className="border-t border-border px-4 py-2 text-caption text-text-muted" aria-hidden>
          Up and down arrows to choose, Enter to open, Esc to close
        </p>
      </div>
    </div>
  );
}

/** Ctrl+K / Cmd+K anywhere opens quick navigation. */
export function useQuickNavShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);
}
