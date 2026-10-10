'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface MoreMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** A destructive or irreversible item, drawn in the error colour. */
  danger?: boolean;
  icon?: ReactNode;
}

/**
 * A labelled "More" button that opens a real menu.
 *
 * DESIGN-DIRECTION: secondary actions live behind a worded button with a chevron, never a row
 * of unlabelled icons. Menu semantics in full: `aria-haspopup`/`aria-expanded` on the button,
 * `role="menu"` with `menuitem`s, arrow keys and Home/End move, Escape closes and puts focus
 * back on the button, and a click outside closes it.
 */
export function MoreMenu({
  items,
  label = 'More',
  accessibleLabel,
  align = 'right',
  upOnPhones = false,
}: {
  items: MoreMenuItem[];
  label?: string;
  /** A fuller name when several menus share a page: "More actions for Skyfront Protocol". */
  accessibleLabel?: string;
  align?: 'left' | 'right';
  /** Open upwards below the `sm` breakpoint, for a menu in a sticky bottom bar. */
  upOnPhones?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const enabled = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
    );

  useEffect(() => {
    if (!open) return;
    enabled()[0]?.focus();
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const list = enabled();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(at + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(at - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className="relative inline-block">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={accessibleLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border-input bg-background-surface px-3 text-button font-medium text-text-primary transition-colors duration-150 hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas active:translate-y-px"
      >
        {label}
        <ChevronDown
          className={`h-4 w-4 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open ? (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={accessibleLabel ?? label}
          onKeyDown={onKey}
          className={`absolute z-30 min-w-[13rem] ${upOnPhones ? 'bottom-full mb-1.5 sm:bottom-auto sm:mb-0 sm:mt-1.5' : 'mt-1.5'} rounded-md border border-border bg-background-elevated p-1 shadow-md ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onSelect();
              }}
              className={`flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-[0.875rem] focus-visible:outline-none focus:bg-background-subtle hover:bg-background-subtle disabled:cursor-not-allowed disabled:opacity-50 ${
                item.danger ? 'text-status-error' : 'text-text-primary'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
