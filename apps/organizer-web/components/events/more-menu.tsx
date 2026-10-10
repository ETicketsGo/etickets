'use client';

import Link from 'next/link';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';

export type MoreMenuItem =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'button'; label: string; onSelect: () => void; danger?: boolean }
  /** Shown, not offered: the reason replaces the action, so nobody hunts for a dead control. */
  | { kind: 'note'; label: string; reason: string };

/**
 * A labelled "More" button that opens a real menu: `aria-haspopup="menu"`, items with
 * `role="menuitem"`, arrow keys and Home/End move between them, Escape closes and puts focus
 * back on the button, Tab closes and moves on.
 *
 * Replaces the row of four unlabelled icon buttons. Those were named for screen readers but
 * were 36px squares that a sighted organizer had to hover to decode - the owner's "actions are
 * tiny icon buttons". Words in a menu say what each one does.
 */
export function MoreMenu({
  items,
  label = 'More',
  /** The accessible name, when the visible "More" needs its subject ("More for Jazz Night"). */
  ariaLabel,
  align = 'end',
}: {
  items: MoreMenuItem[];
  label?: string;
  ariaLabel?: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const focusables = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []).filter(
      (el) => el.getAttribute('aria-disabled') !== 'true',
    );

  /*
    Placed with `position: fixed` from the button's own rectangle. Inside a card or the table's
    sideways-scrolling box an absolutely placed menu was clipped to that box - the last row's
    menu showed one item. Fixed escapes the clipping. It opens upwards when there is no room
    below, and follows its button when the page scrolls (closing only once the button has left
    the screen) - scroll events arrive a frame late, so closing on any scroll shut a menu that
    had just been opened by a click that scrolled its button into view.
  */
  const place = () => {
    const button = buttonRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!button || !menu) return;
    if (button.bottom < 0 || button.top > window.innerHeight) {
      setOpen(false);
      return;
    }
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const gap = 4;
    const wanted = align === 'end' ? button.right - width : button.left;
    const left = Math.max(8, Math.min(wanted, window.innerWidth - width - 8));
    const below = button.bottom + gap;
    const top =
      below + height > window.innerHeight - 8 && button.top - gap - height > 8
        ? button.top - gap - height
        : below;
    setPos({ top, left });
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    placeRef.current();
    const follow = () => placeRef.current();
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !pos) return;
    focusables()[0]?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!pos]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = focusables();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus({ preventScroll: true });
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(list.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') setOpen(false);
  };

  const item =
    'flex w-full min-h-[2.5rem] items-center rounded-md px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:bg-background-subtle';

  return (
    /*
      Clicks stop here: a table row opens its event on click, and the menu's own clicks must
      not also navigate away.
    */
    <div ref={wrapRef} className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-9 items-center gap-1 rounded-md border border-border-input bg-background-surface px-3 text-sm font-medium text-text-primary transition-colors duration-150 hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas active:translate-y-px motion-reduce:transition-none"
      >
        {label}
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 text-text-muted transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={ariaLabel ?? label}
          onKeyDown={onMenuKey}
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          className="fixed z-50 w-64 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-background-elevated p-1 shadow-lg"
        >
          {items.map((it) =>
            it.kind === 'link' ? (
              <Link
                key={it.label}
                href={it.href}
                role="menuitem"
                tabIndex={-1}
                onClick={() => setOpen(false)}
                className={`${item} text-text-primary hover:bg-background-subtle`}
              >
                {it.label}
              </Link>
            ) : it.kind === 'button' ? (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  close(true);
                  it.onSelect();
                }}
                className={`${item} hover:bg-background-subtle ${
                  it.danger ? 'text-status-error' : 'text-text-primary'
                }`}
              >
                {it.label}
              </button>
            ) : (
              <div
                key={it.label}
                role="menuitem"
                aria-disabled="true"
                className="px-3 py-2 text-sm"
              >
                <span className="block text-text-muted">{it.label}</span>
                <span className="mt-0.5 block text-caption text-text-muted">{it.reason}</span>
              </div>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
