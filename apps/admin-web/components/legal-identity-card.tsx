'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  Skeleton,
  MARKETS,
  marketFor,
  useToast,
  errorMessage,
  type OrganizationLegalIdentityFields,
} from '@eticketsgo/web-kit';

/**
 * The seller an invoice names, editable by the platform.
 *
 * ── WHY THIS IS ON THE ADMIN SIDE AT ALL ───────────────────────────────────────────
 * The organizer's owner has been able to record this from their own settings for a while.
 * The platform could not, and during a pilot the platform is the one doing the onboarding —
 * it takes the registration on a call and enters it. Waiting for each owner to sign in and
 * self-serve means every invoice until then goes out as a plain RECEIPT, and a receipt
 * cannot be reissued as a tax invoice afterwards: the document is a snapshot of the facts
 * at the moment it was issued.
 *
 * ── WHY IT SHOWS WHAT IS MISSING RATHER THAN JUST REFUSING ─────────────────────────
 * A registration number alone does not make a tax invoice. It needs a legal name, an
 * address and a finance contact as well, and an admin filling in the GSTIN has no way to
 * know that from a form that simply saves. So the card states the gap in the same words the
 * API uses, and says plainly what documents will be until the gap closes.
 *
 * ── NO FORMAT VALIDATION, DELIBERATELY ─────────────────────────────────────────────
 * There is no GSTIN regex here and none in the schema. Every market has its own format,
 * each subject to change by an authority that does not consult this repository; a pattern
 * here would reject valid identifiers and need a release to correct. Recording faithfully
 * what the organizer states is the platform's job. The authority's job is deciding whether
 * it is valid.
 */
const FIELDS: { key: keyof OrganizationLegalIdentityFields; label: string; hint?: string }[] = [
  {
    key: 'legalName',
    label: 'Registered legal name',
    hint: 'The entity an invoice names, if it differs from the trading name.',
  },
  {
    key: 'taxRegistrationKind',
    label: 'Registration type',
    hint: 'GSTIN, EIN, GST/HST — this labels the number below.',
  },
  { key: 'taxRegistrationNumber', label: 'Registration number' },
  { key: 'registeredAddressLine1', label: 'Registered address' },
  { key: 'registeredAddressLine2', label: 'Address line 2' },
  { key: 'registeredCity', label: 'City' },
  {
    key: 'registeredRegion',
    label: 'State / province',
    hint: 'Also what a regional tax rule matches on.',
  },
  { key: 'registeredPostalCode', label: 'Postal code' },
  { key: 'registeredCountry', label: 'Country' },
  { key: 'financeContactName', label: 'Finance contact name' },
  { key: 'financeContactEmail', label: 'Finance contact email' },
  { key: 'financeContactPhone', label: 'Finance contact phone' },
];

type Draft = Record<string, string>;

export function LegalIdentityCard({ organizationId }: { organizationId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);

  const q = useQuery({
    queryKey: ['org-legal-identity', organizationId],
    queryFn: () => api.admin.organizerLegalIdentity(organizationId),
  });

  // Seeded once from the server, then owned by the form. Re-seeding on every render would
  // discard what the admin is halfway through typing each time the query refetches.
  useEffect(() => {
    if (!q.data || draft) return;
    setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, q.data[f.key] ?? ''])));
  }, [q.data, draft]);

  const save = useMutation({
    mutationFn: () =>
      api.admin.updateOrganizerLegalIdentity(
        organizationId,
        draft as Partial<OrganizationLegalIdentityFields>,
      ),
    onSuccess: async () => {
      toast.push('Seller identity saved.');
      setDraft(null); // re-seed from the server, so what is shown is what was stored
      await qc.invalidateQueries({ queryKey: ['org-legal-identity', organizationId] });
    },
    onError: (e) => toast.push(errorMessage(e)),
  });

  if (q.isLoading || !draft) {
    return (
      <Card title="Seller identity & tax registration">
        <Skeleton className="h-40 w-full" />
      </Card>
    );
  }

  const status = q.data!;

  return (
    <Card title="Seller identity & tax registration">
      <p
        className={`mb-4 rounded-md px-3 py-2 text-caption ${
          status.canIssueTaxInvoice
            ? 'bg-status-success/10 text-status-success'
            : 'bg-status-warning/10 text-status-warning'
        }`}
        role="status"
      >
        {status.canIssueTaxInvoice
          ? 'Complete — documents for this organizer are issued as tax invoices.'
          : status.missing.length > 0
            ? `Documents are issued as plain receipts, not tax invoices. Still needed: ${status.missing.join(', ')}.`
            : 'No tax registration on file, so documents are issued as plain receipts.'}
      </p>

      {/*
        ── WHERE THESE COME FROM ─────────────────────────────────────────────────────
        Asked, reasonably: "how are we getting this information, I do not see anything on the
        organizer side filling it". The organizer does fill it — Settings, "Legal and tax
        details" — and this screen never said so, which makes it look like a back-office form
        with no source and leaves an admin unsure whether typing here is normal or a
        workaround.

        It is the same record, and an admin editing it is acting on the organizer's behalf.
        That is legitimate — support does it while somebody is on the phone — and it is
        audited, so saying whose data it is matters more than hiding the fact.
      */}
      <p className="mb-4 text-caption text-text-muted">
        The organizer maintains these themselves under{' '}
        <strong>Settings → Legal and tax details</strong>. Editing here saves to the same record on
        their behalf, and is recorded in the audit log.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => {
          /*
            Country and state decide which tax rules apply and what a regional rule matches
            on. Typed, a mismatch does not fail — it matches nothing, and the seller is taxed
            under a rule nobody picked.
          */
          if (f.key === 'registeredCountry') {
            return (
              <div key={f.key}>
                <Select
                  label={f.label}
                  value={draft[f.key] ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, [f.key]: e.target.value, registeredRegion: '' })
                  }
                >
                  <option value="">Select a country…</option>
                  {MARKETS.map((m) => (
                    <option key={m.code} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </Select>
                {f.hint && <p className="mt-1 text-caption text-text-muted">{f.hint}</p>}
              </div>
            );
          }
          if (f.key === 'registeredRegion') {
            const market = marketFor(draft.registeredCountry ?? '');
            return (
              <div key={f.key}>
                <Select
                  label={market?.regionLabel ?? f.label}
                  disabled={!market || market.regions.length === 0}
                  value={draft[f.key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                >
                  <option value="">{market ? 'Select…' : 'Pick a country first'}</option>
                  {(market?.regions ?? []).map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </Select>
                {f.hint && <p className="mt-1 text-caption text-text-muted">{f.hint}</p>}
              </div>
            );
          }
          return (
            <div key={f.key} className={f.key === 'legalName' ? 'sm:col-span-2' : undefined}>
              <Input
                label={f.label}
                value={draft[f.key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
              {f.hint && <p className="mt-1 text-caption text-text-muted">{f.hint}</p>}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save seller identity
        </Button>
        {/* Said out loud because it is the surprising part: correcting a number does not
            correct the documents already sent. They are snapshots, and re-issuing one would
            change what a customer was told after the fact. */}
        <p className="text-caption text-text-muted">
          Invoices already issued keep the values they were issued with.
        </p>
      </div>
    </Card>
  );
}
