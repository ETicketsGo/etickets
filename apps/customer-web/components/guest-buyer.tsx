'use client';

import { useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui';
import { Link, usePathname } from '@/i18n/navigation';
import { tokenStore } from '@/lib/api';
import { useMounted } from '@/lib/use-mounted';

/** Who the ticket is for, once the form is satisfied with it. */
export interface GuestBuyer {
  name: string;
  email: string;
}

/**
 * Anything that looks like an address, and nothing that cannot be one.
 *
 * Deliberately loose. The only test that matters is whether the ticket arrives, and the server
 * plus the mail provider are the ones who can answer that -- a clever pattern here rejects
 * valid addresses (an apostrophe, a long new suffix, a plus tag) and buys nothing. What it does
 * catch is the real mistake: a name typed into the email box, or an address with no domain.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface GuestBuyerState {
  /** True only when the browser is in charge AND nobody is signed in. */
  asGuest: boolean;
  buyer: GuestBuyer;
  setBuyer: Dispatch<SetStateAction<GuestBuyer>>;
  errors: { name?: string; email?: string };
  /**
   * The buyer, trimmed, or null -- in which case the form now says what is wrong and the
   * first bad field has focus. Call it before starting a booking and stop on null.
   */
  validate: () => GuestBuyer | null;
}

/** The two field ids, so the hook can put focus where the mistake is. */
const NAME_ID = 'guest-name';
const EMAIL_ID = 'guest-email';

/*
  Focus the field that is wrong.

  By id rather than by ref: the shared `Input` is a plain function component and does not
  forward one, and a page-level focus helper is not a reason to change a component every app
  uses. Focusing also scrolls the field into view, which is what makes the mobile pay bar
  usable -- the button is at the bottom of the screen and the form is above the fold.
*/
function focusField(id: string): void {
  const el = typeof document === 'undefined' ? null : document.getElementById(id);
  if (el instanceof HTMLInputElement) el.focus();
}

/**
 * The state behind "buy without an account".
 *
 * ── WHY `useMounted` AND NOT JUST THE TOKEN ────────────────────────────────────────
 * `tokenStore` reads localStorage, which does not exist while the server renders. A component
 * that branched on the token alone would render the signed-in markup on the server and the
 * guest markup on the client's first pass, and React replaces the whole tree when those two
 * disagree. So the first client render matches the server -- neither form -- and the choice
 * appears a tick later.
 */
export function useGuestBuyer(): GuestBuyerState {
  const mounted = useMounted();
  const [buyer, setBuyer] = useState<GuestBuyer>({ name: '', email: '' });
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const g = useTranslations('storefront.guest');

  const validate = (): GuestBuyer | null => {
    const name = buyer.name.trim();
    const email = buyer.email.trim();
    const next: { name?: string; email?: string } = {};
    // Two characters, not one: a single letter is never a name, and the ticket carries this.
    if (name.length < 2) next.name = g('nameRequired');
    if (!email) next.email = g('emailRequired');
    else if (!EMAIL.test(email)) next.email = g('emailInvalid');
    setErrors(next);
    if (next.name) {
      focusField(NAME_ID);
      return null;
    }
    if (next.email) {
      focusField(EMAIL_ID);
      return null;
    }
    return { name, email };
  };

  return {
    asGuest: mounted && !tokenStore.access,
    buyer,
    setBuyer,
    errors,
    validate,
  };
}

/**
 * The choice a signed-out buyer gets instead of a redirect.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────────────
 * Pressing "Continue to payment" without an account pushed the browser to /login. No
 * sentence said why, nothing said an account was needed, and the chosen tickets were left
 * behind on the page the buyer had just been taken off. People do not make an account at
 * that moment; they leave.
 *
 * Guest first, sign-in second, because that is the order of what the buyer wants. Signing in
 * comes back to this page with `next`, and both screens that use this keep the selection in
 * the browser, so the tickets are still chosen on return.
 */
export function GuestBuyerFields({ state }: { state: GuestBuyerState }) {
  const g = useTranslations('storefront.guest');
  const pathname = usePathname();

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border bg-background-subtle/50 p-4">
      <div>
        <h3 className="text-[0.9375rem] font-semibold text-text-primary">{g('title')}</h3>
        <p className="mt-1 text-caption text-text-muted">{g('lead')}</p>
      </div>
      <Input
        id={NAME_ID}
        label={g('nameLabel')}
        autoComplete="name"
        value={state.buyer.name}
        error={state.errors.name}
        onChange={(e) => state.setBuyer((p) => ({ ...p, name: e.target.value }))}
      />
      <Input
        id={EMAIL_ID}
        label={g('emailLabel')}
        type="email"
        inputMode="email"
        autoComplete="email"
        value={state.buyer.email}
        error={state.errors.email}
        hint={g('emailHint')}
        onChange={(e) => state.setBuyer((p) => ({ ...p, email: e.target.value }))}
      />
      {/*
        Two sentences, on two lines. Run together they read as one -- "Already have an account?
        Sign in We keep your selection on this page." -- because the link ends a sentence and
        the reassurance starts another, with only a space between them.
      */}
      <p className="text-caption text-text-muted">
        {g('haveAccount')}{' '}
        <Link
          href={`/login?next=${encodeURIComponent(pathname)}`}
          className="text-action-primary underline"
        >
          {g('signInInstead')}
        </Link>
      </p>
      <p className="text-caption text-text-muted">{g('selectionKept')}</p>
    </div>
  );
}
