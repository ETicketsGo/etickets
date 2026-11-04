'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiRequestError,
  Button,
  Card,
  Input,
  Textarea,
  Skeleton,
  ErrorState,
  PageHeader,
  StatusBadge,
  useToast,
  errorMessage,
  type OrganizationLegalIdentityInput,
  type OrganizationProfileInput,
} from '@eticketsgo/web-kit';
import {
  ACCENT_THEMES,
  MARKETS,
  marketFor,
  postalCodeProblem,
  issuesTaxInvoices,
  Select,
  type Organization,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { ColorSchemeSwitch } from '@/components/workspace-chrome';
import { ProfilePicture } from './profile-picture';

const PROFILE_FIELDS: {
  key: Exclude<ProfileKey, 'description'>;
  label: string;
  placeholder?: string;
}[] = [
  { key: 'website', label: 'Website', placeholder: 'https://example.com' },
  { key: 'contactEmail', label: 'Public contact email', placeholder: 'hello@example.com' },
  // No example number: one country's format printed in the box tells every other country it
  // is the wrong form to be filling in. The label says what the field is.
  { key: 'contactPhone', label: 'Public contact phone' },
  { key: 'twitterUrl', label: 'X / Twitter', placeholder: 'https://x.com/…' },
  { key: 'instagramUrl', label: 'Instagram', placeholder: 'https://instagram.com/…' },
  { key: 'facebookUrl', label: 'Facebook', placeholder: 'https://facebook.com/…' },
];

/**
 * Everything an invoice has to name.
 *
 * `taxRegistrationKind` is free text on purpose — it labels whatever number the organizer
 * holds (GSTIN in India, EIN in the US, GST/HST in Canada) without this form deciding which
 * markets exist. The placeholder suggests; it does not constrain.
 */
const LEGAL_FIELDS: {
  key: keyof OrganizationLegalIdentityInput;
  label: string;
  placeholder?: string;
  hint?: string;
  wide?: boolean;
}[] = [
  {
    key: 'legalName',
    label: 'Registered legal name',
    // Not an example company: a made-up name in the box read as a value already on file.
    placeholder: 'As on your registration certificate',
    hint: 'The entity name as registered. Printed on every invoice.',
    wide: true,
  },
  /*
    ── COUNTRY BEFORE THE THINGS IT DECIDES ─────────────────────────────────────────
    It used to sit at the bottom, under a state whose hint reads "pick a country first".
    The country decides both the state list and which legal forms exist, so asking for it
    last is asking somebody to fill the form in twice.
  */
  { key: 'registeredCountry', label: 'Country' },
  {
    key: 'legalEntityType',
    label: 'Registered as',
    hint: 'Your legal form. Needed before the platform can approve you.',
  },
  /*
    ── WHY THE TAX FIELDS SAY "IF YOU HAVE ONE" ─────────────────────────────────────
    Plenty of real organizers have no tax registration and cannot get one: in India a
    business below the GST threshold is not eligible to register. Approval asks who you are,
    not whether you are registered. Having one means your buyers get tax invoices instead of
    plain receipts, which is what the hint says and all it says - the platform does not give
    anybody tax advice about whether they should register.
  */
  {
    key: 'taxRegistrationKind',
    label: 'Tax registration type (if you have one)',
    placeholder: 'GSTIN / EIN / GST-HST',
  },
  {
    key: 'taxRegistrationNumber',
    label: 'Tax registration number (if you have one)',
    placeholder: 'As issued to you',
    // The US wording replaces this where the country has no tax invoice (see the field below).
    hint: 'With a registration on file, buyers get tax invoices. Without it, plain receipts.',
  },
  { key: 'registeredAddressLine1', label: 'Registered address', wide: true },
  { key: 'registeredAddressLine2', label: 'Address line 2', wide: true },
  { key: 'registeredCity', label: 'City' },
  { key: 'registeredRegion', label: 'State / province' },
  { key: 'registeredPostalCode', label: 'Postal code' },
  { key: 'financeContactName', label: 'Finance contact name' },
  {
    key: 'financeContactEmail',
    label: 'Finance contact email',
    placeholder: 'finance@example.com',
  },
  { key: 'financeContactPhone', label: 'Finance contact phone' },
  /*
    The person who answers a complaint, which is not the same person as either of the other two.
    `contactEmail` is where a ticket holder asks about a show and the finance contact is where we
    ask about money; a complaint is somebody saying they were wronged, and it needs a name.
  */
  { key: 'grievanceOfficerName', label: 'Complaints contact name' },
  {
    key: 'grievanceOfficerEmail',
    label: 'Complaints contact email',
    placeholder: 'complaints@example.com',
    hint: 'Where a customer complaint about your events is sent. Shown to us, and to them on request.',
  },
  { key: 'grievanceOfficerPhone', label: 'Complaints contact phone' },
];

/*
  ── WHAT A SAVE SENDS: ONLY WHAT CHANGED ──────────────────────────────────────────────
  Both forms used to send every field they held. A field the form had failed to load (the legal
  form never read "Registered as" back) or one written somewhere else (an uploaded picture's path)
  then went out with whatever the form had, and the save overwrote, or was refused over, a value
  the person never touched. Each form now keeps the values it was loaded with and sends the
  difference. A field nobody changed cannot be lost by saving another.
*/
const PROFILE_KEYS = [
  'description',
  'website',
  'contactEmail',
  'contactPhone',
  'twitterUrl',
  'instagramUrl',
  'facebookUrl',
] as const;
type ProfileKey = (typeof PROFILE_KEYS)[number];
type ProfileValues = Record<ProfileKey, string>;

function profileValues(org: Partial<Record<ProfileKey, string | null>>): ProfileValues {
  return Object.fromEntries(PROFILE_KEYS.map((k) => [k, org[k] ?? ''])) as ProfileValues;
}

const LEGAL_KEYS = LEGAL_FIELDS.map((f) => f.key);
type LegalValues = Record<keyof OrganizationLegalIdentityInput, string>;

function legalValues(
  d: Partial<Record<keyof OrganizationLegalIdentityInput, string | null>>,
): LegalValues {
  return Object.fromEntries(LEGAL_KEYS.map((k) => [k, d[k] ?? ''])) as LegalValues;
}

/** The fields whose value differs from what was loaded, as the PATCH body. */
function changed<K extends string>(base: Record<K, string>, now: Record<K, string>) {
  const out: Partial<Record<K, string>> = {};
  for (const k of Object.keys(now) as K[]) {
    if ((now[k] ?? '').trim() !== (base[k] ?? '').trim()) out[k] = now[k].trim();
  }
  return out;
}

const URL_KEYS = new Set<string>(['website', 'twitterUrl', 'instagramUrl', 'facebookUrl']);
const EMAIL_KEYS = new Set<string>([
  'contactEmail',
  'financeContactEmail',
  'grievanceOfficerEmail',
]);
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The problem with one value, checked before it is sent so the person sees it at the field. */
function fieldProblem(key: string, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (URL_KEYS.has(key) && !/^https?:\/\/.+/i.test(v)) {
    return 'Enter a full link starting with https://';
  }
  if (EMAIL_KEYS.has(key) && !LOOKS_LIKE_EMAIL.test(v)) return 'Enter a valid email address.';
  if (key === 'taxRegistrationNumber' && !/^[A-Za-z0-9][A-Za-z0-9 \-/]*$/.test(v)) {
    return 'Use letters, digits, spaces, hyphens or slashes only.';
  }
  return null;
}

/**
 * The API's per-field messages (the validation envelope's `fields`), one per field.
 * A refusal that names a field belongs under that field, not in a toast that disappears.
 */
function apiFieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiRequestError)) return {};
  const fields = (e.details as { fields?: Record<string, string[]> } | undefined)?.fields;
  if (!fields) return {};
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, messages]) => messages.length > 0)
      .map(([key, messages]) => [key, messages[0]]),
  );
}

/**
 * A stored value the list does not offer - an older spelling ("USA", "IN") or a form entered
 * before the list existed - shown as itself. A select that cannot show its own value displays
 * the placeholder, and a saved answer then reads as never given.
 */
function storedOption(value: string, offered: readonly string[]) {
  if (!value || offered.includes(value)) return null;
  return <option value={value}>{value}</option>;
}

export default function SettingsPage() {
  const { activeOrg, can, activeOrgSentenceName } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();

  /*
    Mirrored into local state so the checkbox responds immediately. The org context is
    refreshed on success, but waiting for a round trip before the tick appears makes a
    toggle feel broken.
  */
  const [cashEnabled, setCashEnabled] = useState(activeOrg.cashPaymentsEnabled ?? false);
  /*
    Re-read when the organization changes. Seeded once, the box kept the first organization's
    setting after switching to another, so it could show cash as on for one that has it off.
  */
  useEffect(() => {
    setCashEnabled(activeOrg.cashPaymentsEnabled ?? false);
  }, [activeOrg.id, activeOrg.cashPaymentsEnabled]);
  const cashToggle = useMutation({
    mutationFn: (enabled: boolean) => api.organizations.setCashPayments(activeOrg.id, enabled),
    onMutate: (enabled) => setCashEnabled(enabled),
    onSuccess: (r) => {
      setCashEnabled(r.cashPaymentsEnabled);
      // The org context holds this flag too. Left stale, switching away and back would put the
      // value from before this change back in the box.
      qc.invalidateQueries({ queryKey: ['organizations', 'mine'] });
      toast.push(
        r.cashPaymentsEnabled
          ? 'Cash accepted. Reservations now appear under Counter.'
          : 'Cash turned off. Existing reservations can still be collected.',
        'success',
      );
    },
    onError: (e) => {
      // Put the checkbox back: leaving it ticked would claim a setting that did not save.
      setCashEnabled(activeOrg.cashPaymentsEnabled ?? false);
      toast.push(errorMessage(e), 'error');
    },
  });
  const {
    data: profile,
    isLoading,
    isError,
    refetch,
  } = useQuery({ queryKey: ['profile'], queryFn: () => api.users.profile() });
  const [fullName, setFullName] = useState('');

  /*
    ── PUBLIC PROFILE FORM ──────────────────────────────────────────────────────────────
    Loaded from the active organization, and reloaded from it whenever that record changes
    UNLESS the person has started typing. It used to reload on every change: uploading a picture
    refreshes the organization, and that wiped whatever had been typed into About and not yet
    saved. Switching organization always reloads, so one organization's draft never shows on
    another's page.

    The pictures are not in this form. Their own buttons save them; this form sending their
    paths back is what made every profile save fail after an upload.
  */
  const [profileBase, setProfileBase] = useState<ProfileValues>(() => profileValues(activeOrg));
  const [form, setForm] = useState<ProfileValues>(() => profileValues(activeOrg));
  // A ref, not state: clearing it after a save must not re-run the reload below against the
  // organization still cached from BEFORE the save, which put the old values back on screen.
  const profileTouched = useRef(false);
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const profileOrgId = useRef(activeOrg.id);
  useEffect(() => {
    const switched = profileOrgId.current !== activeOrg.id;
    profileOrgId.current = activeOrg.id;
    setProfileBase(profileValues(activeOrg));
    if (switched || !profileTouched.current) {
      setForm(profileValues(activeOrg));
      profileTouched.current = false;
      setProfileErrors({});
    }
  }, [activeOrg]);
  const setField = (key: ProfileKey, value: string) => {
    profileTouched.current = true;
    setProfileErrors(({ [key]: _gone, ...rest }) => rest);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const profileChanges = changed(profileBase, form);
  const profileDirty = Object.keys(profileChanges).length > 0;

  /** After a save, show what the server stored - the record it returned, not the draft. */
  const settleProfile = (org: Organization) => {
    const saved = profileValues(org);
    setProfileBase(saved);
    setForm(saved);
    profileTouched.current = false;
    qc.invalidateQueries({ queryKey: ['organizations', 'mine'] });
    qc.invalidateQueries({ queryKey: ['organizer', 'actions', activeOrg.id] });
  };

  const saveOrg = useMutation({
    mutationFn: (body: OrganizationProfileInput) =>
      api.organizations.updateProfile(activeOrg.id, body),
    onSuccess: (org) => {
      settleProfile(org);
      toast.push('Organizer profile saved.', 'success');
    },
    onError: (e) => {
      const fields = apiFieldErrors(e);
      setProfileErrors(fields);
      toast.push(
        Object.keys(fields).length > 0
          ? 'Not saved. Check the fields marked in red.'
          : `Not saved. ${errorMessage(e)}`,
        'error',
      );
    },
  });
  const submitProfile = () => {
    const problems: Record<string, string> = {};
    for (const key of PROFILE_KEYS) {
      const problem = fieldProblem(key, form[key]);
      if (problem) problems[key] = problem;
    }
    setProfileErrors(problems);
    if (Object.keys(problems).length > 0) {
      toast.push('Not saved. Check the fields marked in red.', 'error');
      return;
    }
    if (!profileDirty) {
      toast.push('Nothing to save. No field has changed.', 'info');
      return;
    }
    saveOrg.mutate(profileChanges);
  };

  /*
    The workspace colour is its own save. It shared the profile's, so choosing a colour also
    saved whatever was half-typed in the profile box, and saving the profile reset the colour.
  */
  const [theme, setTheme] = useState(activeOrg.consoleTheme ?? 'default');
  useEffect(() => {
    setTheme(activeOrg.consoleTheme ?? 'default');
  }, [activeOrg.id, activeOrg.consoleTheme]);
  const saveTheme = useMutation({
    mutationFn: () =>
      api.organizations.updateProfile(activeOrg.id, {
        consoleTheme: theme as OrganizationProfileInput['consoleTheme'],
      }),
    onSuccess: () => {
      toast.push('Workspace colour saved.', 'success');
      qc.invalidateQueries({ queryKey: ['organizations', 'mine'] });
    },
    onError: (e) => toast.push(`Not saved. ${errorMessage(e)}`, 'error'),
  });

  // ── Legal + tax identity ──────────────────────────────────────────────────────────
  const legalQuery = useQuery({
    queryKey: ['organizations', activeOrg.id, 'legal-identity'],
    queryFn: () => api.organizations.legalIdentity(activeOrg.id),
  });
  /*
    What is still missing from this box, from the same list Overview's "Needs you" reads (one
    query key, so they cannot disagree). The box said "Complete." whenever tax invoices could be
    issued, while Overview warned about the legal form and the complaints contact on the same
    organization.
  */
  const actionsQ = useQuery({
    queryKey: ['organizer', 'actions', activeOrg.id],
    queryFn: () => api.organizations.actions(activeOrg.id),
    staleTime: 30_000,
  });
  const legalGaps = (actionsQ.data?.actions ?? []).filter(
    (a) => !a.done && a.category === 'BUSINESS' && a.fixPath.endsWith('#legal'),
  );
  /*
    ── LEGAL FORM ───────────────────────────────────────────────────────────────────────
    Loaded from the server and kept beside the draft, so a save sends only what changed (see
    `changed`). It used to copy fifteen of the sixteen fields back from the server: "Registered
    as" was saved but never loaded, so the form showed "Select..." after every reload, and the
    owner was told nothing had been kept.

    Reloaded from the server whenever it changes unless the owner has started typing, so a
    background refresh cannot overwrite half-finished input.
  */
  // Where the SAVED country has no tax invoice (US), sales are receipts whatever number is on file.
  const savedReceiptsOnly = legalQuery.data
    ? !issuesTaxInvoices(legalQuery.data.registeredCountry, legalQuery.data.taxRegistrationKind)
    : false;
  const savedRegistrationLabel =
    legalQuery.data?.taxRegistrationKind ||
    marketFor(legalQuery.data?.registeredCountry)?.taxRegistrationLabel ||
    'registration';
  const [legalBase, setLegalBase] = useState<LegalValues>(() => legalValues({}));
  const [legal, setLegal] = useState<LegalValues>(() => legalValues({}));
  // A ref for the same reason as `profileTouched`.
  const legalTouched = useRef(false);
  const [legalErrors, setLegalErrors] = useState<Record<string, string>>({});
  const legalOrgId = useRef(activeOrg.id);
  useEffect(() => {
    const switched = legalOrgId.current !== activeOrg.id;
    legalOrgId.current = activeOrg.id;
    if (switched) {
      legalTouched.current = false;
      setLegalErrors({});
    }
    const d = legalQuery.data;
    if (!d) return;
    setLegalBase(legalValues(d));
    if (switched || !legalTouched.current) setLegal(legalValues(d));
  }, [legalQuery.data, activeOrg.id]);
  const setLegalFields = (patch: Partial<LegalValues>) => {
    legalTouched.current = true;
    setLegalErrors((errs) => {
      const next = { ...errs };
      for (const k of Object.keys(patch)) delete next[k];
      return next;
    });
    setLegal((f) => ({ ...f, ...patch }));
  };
  const setLegalField = (key: keyof OrganizationLegalIdentityInput, value: string) =>
    setLegalFields({ [key]: value });
  const legalChanges = changed(legalBase, legal);
  const legalDirty = Object.keys(legalChanges).length > 0;

  const saveLegal = useMutation({
    mutationFn: (body: OrganizationLegalIdentityInput) =>
      api.organizations.updateLegalIdentity(activeOrg.id, body),
    onSuccess: (org) => {
      /*
        Show what the server stored straight away, from the record it returned. Waiting for the
        refetch left the old values on screen for a moment, which read as the save not taking.
      */
      const saved = legalValues(org as Partial<Record<keyof LegalValues, string | null>>);
      setLegalBase(saved);
      setLegal(saved);
      legalTouched.current = false;
      toast.push('Legal and tax details saved.', 'success');
      qc.invalidateQueries({ queryKey: ['organizations', activeOrg.id, 'legal-identity'] });
      qc.invalidateQueries({ queryKey: ['organizer', 'actions', activeOrg.id] });
      qc.invalidateQueries({ queryKey: ['organizations', 'mine'] });
    },
    onError: (e) => {
      const fields = apiFieldErrors(e);
      setLegalErrors(fields);
      toast.push(
        Object.keys(fields).length > 0
          ? 'Not saved. Check the fields marked in red.'
          : `Not saved. ${errorMessage(e)}`,
        'error',
      );
    },
  });
  const submitLegal = () => {
    const problems: Record<string, string> = {};
    for (const key of LEGAL_KEYS) {
      const problem = fieldProblem(key, legal[key]);
      if (problem) problems[key] = problem;
    }
    const postal = postalCodeProblem(legal.registeredCountry, legal.registeredPostalCode);
    if (postal) problems.registeredPostalCode = postal;
    setLegalErrors(problems);
    if (Object.keys(problems).length > 0) {
      toast.push('Not saved. Check the fields marked in red.', 'error');
      return;
    }
    if (!legalDirty) {
      toast.push('Nothing to save. No field has changed.', 'info');
      return;
    }
    saveLegal.mutate(legalChanges);
  };

  /*
    Leaving with unsaved edits asks first. Both forms hold their draft only in this page, so a
    refresh or a closed tab used to drop it without a word.
  */
  const unsaved = profileDirty || legalDirty;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  useEffect(() => {
    if (profile) setFullName(profile.fullName);
  }, [profile]);

  const save = useMutation({
    mutationFn: () => api.users.updateProfile(fullName),
    onSuccess: () => {
      toast.push('Profile updated.', 'success');
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Organization">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-text-muted">Name</dt>
              <dd className="text-text-primary">{activeOrg.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Status</dt>
              <dd>
                <StatusBadge status={activeOrg.status} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Contact</dt>
              <dd className="text-text-primary">{activeOrg.contactEmail ?? '—'}</dd>
            </div>
          </dl>
        </Card>
        {/*
          Taking cash is an operational decision, not a profile field, so it sits with the
          organization rather than beside the logo. The copy says what changes when it is on
          — an organizer who discovers at settlement that cash is not in their payout has
          been badly served by a bare toggle.
        */}
        <Card title="Cash at the venue">
          <div className="space-y-3">
            <p className="text-[0.9375rem] text-text-secondary">
              Let people reserve seats online and pay you in cash when they arrive. Seats are held
              until the show starts, and your staff mark them paid from <strong>Counter</strong>.
              Selling to somebody standing at the counter does not need this.
            </p>
            <p className="text-caption text-text-muted">
              This money never passes through ETicketsGo, so it is not part of a payout and no card
              fee is taken from it.
            </p>
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                checked={cashEnabled}
                disabled={cashToggle.isPending || !can.ownerActions}
                onChange={(e) => cashToggle.mutate(e.target.checked)}
              />
              <span className="text-[0.9375rem] text-text-primary">Accept cash at the venue</span>
            </label>
            {!can.ownerActions && (
              // The API lets only the owner change this; the current setting stays readable.
              <p className="text-caption text-text-muted">Only the owner can change this.</p>
            )}
          </div>
        </Card>

        <Card title="Your profile">
          {isError ? (
            <ErrorState
              message="We couldn't load this. Please try again."
              onRetry={() => refetch()}
            />
          ) : isLoading || !profile ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-11 w-32" />
            </div>
          ) : (
            <div className="space-y-3">
              <Input
                id="name"
                label="Full name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
              <Input id="email" label="Email" value={profile.email ?? ''} disabled />
              <Button loading={save.isPending} onClick={() => save.mutate()}>
                Save profile
              </Button>
            </div>
          )}
        </Card>
      </div>

      {/*
        Appearance.

        Two settings that look like one and belong to different people: the accent is the
        ORGANIZATION's — a brand every member shares — and light or dark is the PERSON's,
        because it is about their eyes and the room they are in. Saying which is which on the
        screen itself saves an owner wondering why their choice of dark mode did not reach the
        box office.
      */}
      <Card title="Appearance">
        <p className="-mt-2 mb-4 text-caption text-text-secondary">
          Make this workspace look like yours. Every palette here is checked for contrast in both
          light and dark, so whichever you pick stays readable.
        </p>

        <fieldset className="space-y-3">
          <legend className="text-caption font-medium text-text-secondary">
            Workspace colour — everyone in {activeOrgSentenceName} sees this
          </legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Workspace colour">
            {ACCENT_THEMES.map((t) => {
              const current = theme === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={current}
                  onClick={() => setTheme(t.key)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[0.9375rem] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                    current
                      ? 'border-action-primary bg-tint-primary font-semibold text-action-primary'
                      : 'border-border text-text-secondary hover:bg-background-subtle'
                  }`}
                >
                  <span
                    aria-hidden
                    className="h-4 w-4 shrink-0 rounded-full border border-black/10"
                    style={{ backgroundColor: t.swatch }}
                  />
                  {t.label}
                </button>
              );
            })}
          </div>
          <Button loading={saveTheme.isPending} onClick={() => saveTheme.mutate()}>
            Save workspace colour
          </Button>
        </fieldset>

        <div className="mt-6 border-t border-border pt-5">
          <p className="text-caption font-medium text-text-secondary">
            Light or dark — this device only
          </p>
          <p className="mt-1 text-caption text-text-muted">
            Yours alone. It is saved on this device and takes effect straight away.
          </p>
          <div className="mt-3">
            <ColorSchemeSwitch />
          </div>
        </div>
      </Card>

      {/*
        Ids for the "Fix this" links (`#public-profile`, `#legal`): this page is about 3,400px
        long and the legal box is near the bottom, so landing on its top meant scrolling past
        four unrelated cards to find the field you were sent for.
      */}
      <div id="public-profile" className="scroll-mt-24">
        <Card title="Public organizer profile">
          <p className="-mt-2 mb-4 text-caption text-text-secondary">
            Shown on your organizer page and event listings. Leave a field blank to hide it.
          </p>
          <div className="space-y-4">
            {/*
            The picture is uploaded, not linked. It sits above the text because it is the
            first thing a customer sees of an organizer, and because the field it replaced -
            "Logo URL" - was the one nobody could fill in.
          */}
            <ProfilePicture
              orgId={activeOrg.id}
              name={activeOrg.name}
              logoUrl={activeOrg.logoUrl}
              coverImageUrl={activeOrg.coverImageUrl}
            />
            <Textarea
              id="org-description"
              label="About"
              rows={4}
              maxLength={2000}
              placeholder="Tell attendees who you are and what you host."
              value={form.description}
              error={profileErrors.description}
              onChange={(e) => setField('description', e.target.value)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              {PROFILE_FIELDS.map((f) => (
                <Input
                  key={f.key}
                  id={`org-${f.key}`}
                  label={f.label}
                  placeholder={f.placeholder}
                  value={form[f.key]}
                  error={profileErrors[f.key]}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                loading={saveOrg.isPending}
                onClick={submitProfile}
                data-testid="save-organizer-profile"
              >
                Save organizer profile
              </Button>
              {profileDirty ? (
                <p className="text-caption text-text-muted" role="status">
                  You have changes that are not saved.
                </p>
              ) : null}
            </div>
          </div>
        </Card>
      </div>

      <div id="legal" className="scroll-mt-24">
        <Card title="Legal and tax details">
          <p className="-mt-2 mb-4 text-caption text-text-secondary">
            These appear on the receipts and invoices your customers receive, and on the records
            your payouts are reported against. They are never shown on your public page.
          </p>

          {/*
            ── WHAT THE BUYER'S DOCUMENT IS CALLED, SAID TRUTHFULLY ─────────────────────────
            Read from what is SAVED, not the draft. The document's title follows one fact: a
            registration number on file makes it "tax invoice" (receipt-document.ts,
            resolveSaleKind). This box used to tie that title to the finance contact as well,
            and told an owner with an EIN on file that their documents "cannot be called a tax
            invoice" while every one of them already was. It also claims no more than the
            platform knows: we print the number, we do not check it with the tax authority.
          */}
          {legalQuery.data ? (
            <div
              data-testid="legal-document-status"
              className={`mb-4 rounded-md border px-3 py-2 text-caption text-text-primary ${
                legalQuery.data.canIssueTaxInvoice ||
                (savedReceiptsOnly && legalQuery.data.missing.length === 0)
                  ? 'border-status-success/40 bg-status-success/10'
                  : 'border-status-warning/40 bg-status-warning/10'
              }`}
            >
              {legalQuery.data.taxRegistrationNumber && !savedReceiptsOnly ? (
                <>
                  Your buyers get documents titled <strong>tax invoice</strong> that show your{' '}
                  {savedRegistrationLabel} {legalQuery.data.taxRegistrationNumber}. We print the
                  number as you enter it. We do not check it with your tax authority, so confirm
                  with your tax adviser that these documents meet your local invoice rules.
                </>
              ) : legalQuery.data.taxRegistrationNumber ? (
                /*
                  US: an EIN is not a sales-tax registration, and a receipt does not become a "tax
                  invoice" because one is on file (owner decision, 2026-11-04).
                */
                <>
                  Your buyers get a <strong>receipt</strong> for every sale. It shows your{' '}
                  {savedRegistrationLabel} {legalQuery.data.taxRegistrationNumber} as you entered
                  it.
                </>
              ) : savedReceiptsOnly ? (
                <>
                  Your buyers get a <strong>receipt</strong> for every sale.
                </>
              ) : (
                <>
                  Your buyers get a <strong>receipt</strong> for every sale. It is not titled tax
                  invoice, because no tax registration number is saved.
                </>
              )}
              {legalQuery.data.missing.length > 0 ? (
                <>
                  {' '}
                  Incomplete. These details are still blank on the documents:{' '}
                  {legalQuery.data.missing.join(', ').toLowerCase()}.
                </>
              ) : null}
            </div>
          ) : null}

          {legalGaps.length > 0 && (
            <div className="mb-4 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-caption text-text-primary">
              <p className="font-semibold">Still missing here</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {legalGaps.map((g) => (
                  <li key={g.key}>
                    {g.title}. <span className="text-text-secondary">{g.consequence}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {legalQuery.isError ? (
            <ErrorState
              message="We could not load your legal and tax details. Nothing has been changed."
              onRetry={() => legalQuery.refetch()}
            />
          ) : !legalQuery.data ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {LEGAL_FIELDS.map((f) => {
                  /*
                  ── THE TWO THAT DECIDE SOMETHING ARE PICKED, NOT TYPED ──────────────────
                  `registeredCountry` and `registeredRegion` are not description: the country
                  decides which tax rules can apply to this seller at all, and the region is
                  what a regional rule MATCHES ON. Typed, they have to equal a value the rules
                  use, exactly — and a mismatch does not fail, it silently matches nothing and
                  the seller is taxed under a rule nobody chose.

                  The rest stay free text on purpose. A registration number's format is its
                  authority's business, and an address is an address.
                */
                  const market = marketFor(legal.registeredCountry);
                  if (f.key === 'registeredCountry') {
                    return (
                      <div key={f.key}>
                        <Select
                          id={`legal-${f.key}`}
                          label={f.label}
                          hint="Decides which tax rules can apply to your sales."
                          error={legalErrors[f.key]}
                          value={legal.registeredCountry}
                          onChange={(e) => {
                            const next = marketFor(e.target.value);
                            /*
                              A region belongs to a country; keeping the old one would leave a
                              Telangana registration on a Canadian entity. So does a legal form:
                              "Pvt Ltd" is not something you can be in Canada. Each is cleared
                              only when the new country does not have it, and nothing is saved
                              until the owner presses Save, so a slip of the dropdown loses
                              nothing that is on file.
                            */
                            const regionFits = next?.regions.some(
                              (r) => r.name === legal.registeredRegion,
                            );
                            const formFits = next?.legalEntityTypes.includes(legal.legalEntityType);
                            setLegalFields({
                              registeredCountry: e.target.value,
                              ...(regionFits ? {} : { registeredRegion: '' }),
                              ...(formFits ? {} : { legalEntityType: '' }),
                            });
                          }}
                        >
                          <option value="">Select a country</option>
                          {storedOption(
                            legal.registeredCountry,
                            MARKETS.map((m) => m.name),
                          )}
                          {MARKETS.map((m) => (
                            <option key={m.code} value={m.name}>
                              {m.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                    );
                  }
                  if (f.key === 'legalEntityType') {
                    const forms = market?.legalEntityTypes ?? [];
                    return (
                      <div key={f.key}>
                        <Select
                          id={`legal-${f.key}`}
                          label={f.label}
                          hint={f.hint}
                          error={legalErrors[f.key]}
                          disabled={forms.length === 0 && !legal.legalEntityType}
                          value={legal.legalEntityType}
                          onChange={(e) => setLegalField(f.key, e.target.value)}
                        >
                          <option value="">{market ? 'Select' : 'Pick a country first'}</option>
                          {storedOption(legal.legalEntityType, forms)}
                          {forms.map((form) => (
                            <option key={form} value={form}>
                              {form}
                            </option>
                          ))}
                        </Select>
                      </div>
                    );
                  }
                  if (f.key === 'registeredRegion') {
                    const regions = (market?.regions ?? []).map((r) => r.name);
                    return (
                      <div key={f.key}>
                        <Select
                          id={`legal-${f.key}`}
                          label={market?.regionLabel ?? f.label}
                          disabled={regions.length === 0 && !legal.registeredRegion}
                          hint={f.hint}
                          error={legalErrors[f.key]}
                          value={legal.registeredRegion}
                          onChange={(e) => setLegalField(f.key, e.target.value)}
                        >
                          <option value="">{market ? 'Select' : 'Pick a country first'}</option>
                          {storedOption(legal.registeredRegion, regions)}
                          {regions.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </Select>
                      </div>
                    );
                  }
                  /*
                    "Tax registration number" is what the platform calls it; "GSTIN" is what the
                    organizer calls it, and they are looking for the one on their own
                    certificate. A postal code is a ZIP code or a PIN code the same way.
                  */
                  const label =
                    f.key === 'taxRegistrationNumber' && market
                      ? `${market.taxRegistrationLabel} (if you have one)`
                      : f.key === 'registeredPostalCode' && market?.postalCode
                        ? market.postalCode.label
                        : f.label;
                  const placeholder =
                    f.key === 'taxRegistrationKind' && market
                      ? market.taxRegistrationLabel
                      : f.placeholder;
                  return (
                    <div key={f.key} className={f.wide ? 'sm:col-span-2' : undefined}>
                      <Input
                        id={`legal-${f.key}`}
                        label={label}
                        placeholder={placeholder}
                        hint={
                          f.key === 'taxRegistrationNumber' &&
                          market &&
                          !issuesTaxInvoices(legal.registeredCountry)
                            ? 'Printed on the receipts your buyers get. It does not make them tax invoices.'
                            : f.hint
                        }
                        error={legalErrors[f.key]}
                        value={legal[f.key]}
                        onChange={(e) => setLegalField(f.key, e.target.value)}
                      />
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-caption text-text-muted">
                We record your registration number exactly as you enter it and print it unchanged.
                We do not check its format, because each tax authority sets its own. Documents
                already issued keep the details they were issued with.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  loading={saveLegal.isPending}
                  disabled={!can.ownerActions}
                  onClick={submitLegal}
                  data-testid="save-legal-details"
                >
                  Save legal and tax details
                </Button>
                {legalDirty && can.ownerActions ? (
                  <p className="text-caption text-text-muted" role="status">
                    You have changes that are not saved.
                  </p>
                ) : null}
              </div>
            </>
          )}
          {!can.ownerActions && (
            /*
            Owner only at the API: these details are printed on tax invoices, and changing a
            registration number is a different act from editing a bio.
          */
            <p className="mt-2 text-caption text-text-muted">
              Only the owner can change legal and tax details.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
