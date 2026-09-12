'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  api,
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
import { ACCENT_THEMES, MARKETS, marketFor, Select } from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { ColorSchemeSwitch } from '@/components/workspace-chrome';

const PROFILE_FIELDS: {
  key: keyof OrganizationProfileInput;
  label: string;
  placeholder?: string;
}[] = [
  { key: 'website', label: 'Website', placeholder: 'https://example.com' },
  { key: 'contactEmail', label: 'Public contact email', placeholder: 'hello@example.com' },
  { key: 'contactPhone', label: 'Public contact phone', placeholder: '+91 98765 43210' },
  { key: 'logoUrl', label: 'Logo URL', placeholder: 'https://…/logo.png' },
  { key: 'coverImageUrl', label: 'Cover image URL', placeholder: 'https://…/cover.jpg' },
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
    placeholder: 'Aurora Live Entertainment Pvt Ltd',
    hint: 'The entity name as registered. Printed on every invoice.',
    wide: true,
  },
  {
    key: 'taxRegistrationKind',
    label: 'Tax registration type',
    placeholder: 'GSTIN / EIN / GST-HST',
  },
  {
    key: 'taxRegistrationNumber',
    label: 'Tax registration number',
    placeholder: 'As issued to you',
  },
  { key: 'registeredAddressLine1', label: 'Registered address', wide: true },
  { key: 'registeredAddressLine2', label: 'Address line 2', wide: true },
  { key: 'registeredCity', label: 'City' },
  { key: 'registeredRegion', label: 'State / province' },
  { key: 'registeredPostalCode', label: 'Postal code' },
  { key: 'registeredCountry', label: 'Country', placeholder: 'India' },
  { key: 'financeContactName', label: 'Finance contact name' },
  {
    key: 'financeContactEmail',
    label: 'Finance contact email',
    placeholder: 'finance@example.com',
  },
  { key: 'financeContactPhone', label: 'Finance contact phone' },
];

export default function SettingsPage() {
  const { activeOrg, can } = useOrg();
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

  // Public organizer profile form, seeded from the active org.
  const [form, setForm] = useState<OrganizationProfileInput>({});
  useEffect(() => {
    setForm({
      description: activeOrg.description ?? '',
      website: activeOrg.website ?? '',
      contactEmail: activeOrg.contactEmail ?? '',
      contactPhone: activeOrg.contactPhone ?? '',
      logoUrl: activeOrg.logoUrl ?? '',
      coverImageUrl: activeOrg.coverImageUrl ?? '',
      twitterUrl: activeOrg.twitterUrl ?? '',
      instagramUrl: activeOrg.instagramUrl ?? '',
      facebookUrl: activeOrg.facebookUrl ?? '',
      // 'default' rather than '' so the picker always has a selected option: an organization
      // that has never chosen is on the platform blue, which IS a state, not an absence.
      consoleTheme: activeOrg.consoleTheme ?? 'default',
    });
  }, [activeOrg]);
  const setField = (key: keyof OrganizationProfileInput, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const saveOrg = useMutation({
    mutationFn: () => api.organizations.updateProfile(activeOrg.id, form),
    onSuccess: () => {
      toast.push('Organizer profile updated.', 'success');
      qc.invalidateQueries({ queryKey: ['organizations', 'mine'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  // ── Legal + tax identity ──────────────────────────────────────────────────────────
  const legalQuery = useQuery({
    queryKey: ['organizations', activeOrg.id, 'legal-identity'],
    queryFn: () => api.organizations.legalIdentity(activeOrg.id),
  });
  const [legal, setLegal] = useState<OrganizationLegalIdentityInput>({});
  const [legalTouched, setLegalTouched] = useState(false);
  useEffect(() => {
    // Only seed from the server while the operator has not started typing, so a background
    // refetch cannot overwrite half-finished input.
    if (legalTouched) return;
    const d = legalQuery.data;
    if (!d) return;
    setLegal({
      legalName: d.legalName ?? '',
      taxRegistrationKind: d.taxRegistrationKind ?? '',
      taxRegistrationNumber: d.taxRegistrationNumber ?? '',
      registeredAddressLine1: d.registeredAddressLine1 ?? '',
      registeredAddressLine2: d.registeredAddressLine2 ?? '',
      registeredCity: d.registeredCity ?? '',
      registeredRegion: d.registeredRegion ?? '',
      registeredPostalCode: d.registeredPostalCode ?? '',
      registeredCountry: d.registeredCountry ?? '',
      financeContactName: d.financeContactName ?? '',
      financeContactEmail: d.financeContactEmail ?? '',
      financeContactPhone: d.financeContactPhone ?? '',
    });
  }, [legalQuery.data, legalTouched]);
  const setLegalField = (key: keyof OrganizationLegalIdentityInput, value: string) => {
    setLegalTouched(true);
    setLegal((f) => ({ ...f, [key]: value }));
  };
  const saveLegal = useMutation({
    mutationFn: () => api.organizations.updateLegalIdentity(activeOrg.id, legal),
    onSuccess: () => {
      setLegalTouched(false);
      toast.push('Legal and tax details saved.', 'success');
      qc.invalidateQueries({ queryKey: ['organizations', activeOrg.id, 'legal-identity'] });
      qc.invalidateQueries({ queryKey: ['organizations', 'mine'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

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
            Workspace colour — everyone in {activeOrg.name} sees this
          </legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Workspace colour">
            {ACCENT_THEMES.map((t) => {
              const current = (form.consoleTheme ?? 'default') === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={current}
                  onClick={() => setField('consoleTheme', t.key)}
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
          <Button loading={saveOrg.isPending} onClick={() => saveOrg.mutate()}>
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

      <Card title="Public organizer profile">
        <p className="-mt-2 mb-4 text-caption text-text-secondary">
          Shown on your organizer page and event listings. Leave a field blank to hide it.
        </p>
        <div className="space-y-4">
          <Textarea
            id="org-description"
            label="About"
            rows={4}
            maxLength={2000}
            placeholder="Tell attendees who you are and what you host."
            value={form.description ?? ''}
            onChange={(e) => setField('description', e.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {PROFILE_FIELDS.map((f) => (
              <Input
                key={f.key}
                id={`org-${f.key}`}
                label={f.label}
                placeholder={f.placeholder}
                value={(form[f.key] as string) ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            ))}
          </div>
          <Button loading={saveOrg.isPending} onClick={() => saveOrg.mutate()}>
            Save organizer profile
          </Button>
        </div>
      </Card>

      <Card title="Legal and tax details">
        <p className="-mt-2 mb-4 text-caption text-text-secondary">
          These appear on the receipts and invoices your customers receive, and on the records your
          payouts are reported against. They are never shown on your public page.
        </p>

        {legalQuery.data ? (
          <div
            className={`mb-4 rounded-md border px-3 py-2 text-caption ${
              legalQuery.data.canIssueTaxInvoice
                ? 'border-success/40 bg-success/10 text-text-primary'
                : 'border-warning/40 bg-warning/10 text-text-primary'
            }`}
          >
            {legalQuery.data.canIssueTaxInvoice ? (
              <>
                Complete. Sales are documented as <strong>tax invoices</strong> naming{' '}
                {legalQuery.data.taxRegistrationKind ?? 'your registration'}{' '}
                {legalQuery.data.taxRegistrationNumber}.
              </>
            ) : (
              <>
                Incomplete. Customers still get a <strong>receipt</strong> for every sale, but it
                cannot be called a tax invoice until you add
                {legalQuery.data.taxRegistrationNumber ? '' : ' a tax registration number'}
                {legalQuery.data.missing.length > 0 && (
                  <>
                    {legalQuery.data.taxRegistrationNumber ? ' ' : ', plus '}
                    {legalQuery.data.missing.join(', ').toLowerCase()}
                  </>
                )}
                .
              </>
            )}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {LEGAL_FIELDS.map((f) => {
            /*
              ── THE TWO THAT DECIDE SOMETHING ARE PICKED, NOT TYPED ──────────────────
              `registeredCountry` and `registeredRegion` are not description: the country
              decides which tax rules can apply to this seller at all, and the region is what
              a regional rule MATCHES ON. Typed, they have to equal a value the rules use,
              exactly — and a mismatch does not fail, it silently matches nothing and the
              seller is taxed under a rule nobody chose.

              The rest stay free text on purpose. A registration number's format is its
              authority's business, and an address is an address.
            */
            if (f.key === 'registeredCountry') {
              return (
                <div key={f.key}>
                  <Select
                    id={`legal-${f.key}`}
                    label={f.label}
                    hint="Decides which tax rules can apply to your sales."
                    value={(legal[f.key] as string) ?? ''}
                    onChange={(e) => {
                      setLegalField(f.key, e.target.value);
                      // A region belongs to a country; keeping the old one would leave a
                      // Telangana registration on a Canadian entity.
                      setLegalField('registeredRegion', '');
                    }}
                  >
                    <option value="">Select a country…</option>
                    {MARKETS.map((m) => (
                      <option key={m.code} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            }
            if (f.key === 'registeredRegion') {
              const market = marketFor((legal.registeredCountry as string) ?? '');
              return (
                <div key={f.key}>
                  <Select
                    id={`legal-${f.key}`}
                    label={market?.regionLabel ?? f.label}
                    disabled={!market || market.regions.length === 0}
                    hint={f.hint}
                    value={(legal[f.key] as string) ?? ''}
                    onChange={(e) => setLegalField(f.key, e.target.value)}
                  >
                    <option value="">{market ? 'Select…' : 'Pick a country first'}</option>
                    {(market?.regions ?? []).map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            }
            return (
              <div key={f.key} className={f.wide ? 'sm:col-span-2' : undefined}>
                <Input
                  id={`legal-${f.key}`}
                  label={f.label}
                  placeholder={f.placeholder}
                  value={(legal[f.key] as string) ?? ''}
                  onChange={(e) => setLegalField(f.key, e.target.value)}
                />
                {f.hint ? <p className="mt-1 text-caption text-text-muted">{f.hint}</p> : null}
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-caption text-text-muted">
          We record your registration number exactly as you enter it and print it unchanged. We do
          not validate its format — that varies by country and is set by your tax authority, not by
          us. Documents already issued keep the details they were issued with.
        </p>
        <Button
          className="mt-4"
          loading={saveLegal.isPending}
          disabled={!can.ownerActions}
          onClick={() => saveLegal.mutate()}
        >
          Save legal and tax details
        </Button>
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
  );
}
