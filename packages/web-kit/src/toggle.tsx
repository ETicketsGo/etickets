'use client';

import { forwardRef } from 'react';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Required. A switch with no accessible name is a switch nobody can operate blind. */
  'aria-label': string;
  id?: string;
}

/**
 * An on/off switch.
 *
 * ── WHY IT IS A CHECKBOX UNDERNEATH ────────────────────────────────────────────────
 * Because a checkbox already IS this control to everything that matters: it is focusable, it
 * toggles on space, it announces its state, and it participates in a form. The common
 * alternative — a `div` with `role="switch"` and a click handler — has to reimplement every
 * one of those, and reliably reimplements about half.
 *
 * `role="switch"` is set on top so a screen reader says "on"/"off" rather than
 * "checked"/"unchecked", which is what this control means. The visual is a sibling element
 * driven entirely by `peer-checked` and `peer-focus-visible`, so the real input keeps the
 * focus and the keyboard behaviour while being invisible rather than hidden — `display: none`
 * would take it out of the tab order and undo the whole point.
 *
 * ── WHY DISABLED IS A REAL STATE HERE ──────────────────────────────────────────────
 * Settings screens use this for channels policy guarantees, which cannot be switched off. A
 * disabled switch that still LOOKS interactive is worse than none, so the cursor and the
 * opacity both say so, and the caller is expected to explain why next to it.
 */
export const Toggle = forwardRef<HTMLInputElement, ToggleProps>(function Toggle(
  { checked, onChange, disabled, id, ...rest },
  ref,
) {
  return (
    <span className="inline-flex items-center">
      <input
        ref={ref}
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={rest['aria-label']}
        onChange={(e) => onChange(e.target.checked)}
        /*
          `sr-only` rather than `hidden`: the input must stay in the accessibility tree and in
          the tab order. `peer` is what lets the track and knob below react to its state
          without any JavaScript of their own.
        */
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        onClick={() => {
          // The visual is a label for the input in every sense except the markup, so a click
          // on it has to do what a click on a label would.
          if (!disabled) onChange(!checked);
        }}
        className={[
          'relative h-6 w-11 shrink-0 rounded-full transition-colors',
          'bg-border peer-checked:bg-accent',
          'peer-focus-visible:outline peer-focus-visible:outline-2',
          'peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0',
          ].join(' ')}
        />
      </span>
    </span>
  );
});
