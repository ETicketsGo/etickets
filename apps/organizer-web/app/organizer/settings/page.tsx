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
import { useOrg } from '@/components/org-context';

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
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
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
      registeredCity: d.registeredCity ?? '',
      registeredCountry: d.registeredCountry ?? '',
      financeContactEmail: d.financeContactEmail ?? '',
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
          {LEGAL_FIELDS.map((f) => (
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
          ))}
        </div>
        <p className="mt-4 text-caption text-text-muted">
          We record your registration number exactly as you enter it and print it unchanged. We do
          not validate its format — that varies by country and is set by your tax authority, not by
          us. Documents already issued keep the details they were issued with.
        </p>
        <Button className="mt-4" loading={saveLegal.isPending} onClick={() => saveLegal.mutate()}>
          Save legal and tax details
        </Button>
      </Card>
    </div>
  );
}
