'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  api,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Textarea,
  errorMessage,
  useToast,
  type AdminCinemaRow,
  type CinemaLegalTypeBody,
  type Column,
} from '@eticketsgo/web-kit';
import { RecordHistory } from '@/components/record-history';
import { NO_READ_ACCESS, READ_ONLY_NOTE, useConfigAccess } from '@/lib/capabilities';
import {
  CLIMATE_OPTIONS,
  FORMAT_OPTIONS,
  LOCAL_BODY_OPTIONS,
  legalTypeSummary,
} from '@/lib/cinema-legal-type';

/**
 * Every cinema's legal type: local body, format and cooling.
 *
 * ── WHY THIS PAGE EXISTS ───────────────────────────────────────────────────────────
 * A state rate order prices a cinema by its legal type - an Andhra Pradesh multiplex in a
 * Municipal Corporation may charge more than one in a Gram Panchayat - so the legal type IS the
 * cinema's price limit. Organizers cannot set it (the API refuses them; they would be choosing
 * their own cap), and until now nobody could: readiness said "contact support" and support had
 * no screen to do it from. This is that screen. Each change needs a reason and is recorded with
 * who made it and what it was before, in the same transaction as the change.
 *
 * Reached from Cinema pricing (the policies match on these fields), not from a nav entry of its
 * own. An organizer's request carries this page's address with `?cinema=<id>`, which opens that
 * cinema straight away.
 */
export default function AdminCinemas() {
  const access = useConfigAccess();
  const params = useSearchParams();
  const linked = params.get('cinema') ?? '';
  const [q, setQ] = useState(linked);
  const [applied, setApplied] = useState(linked);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AdminCinemaRow | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'cinemas', page, applied],
    queryFn: () => api.admin.cinemas({ q: applied || undefined, page, pageSize: 20 }),
    enabled: access.mayRead,
  });

  // Opened from a support request: go straight to that cinema.
  const [openedLinked, setOpenedLinked] = useState(false);
  useEffect(() => {
    if (!linked || openedLinked || !data) return;
    const row = data.data.find((r) => r.id === linked);
    if (row) setEditing(row);
    setOpenedLinked(true);
  }, [linked, openedLinked, data]);

  const columns: Column<AdminCinemaRow>[] = [
    {
      key: 'cinema',
      header: 'Cinema',
      render: (r) => (
        <div className="min-w-0">
          <p className="font-medium text-text-primary">{r.name}</p>
          <p className="text-xs text-text-muted">{r.organization.name}</p>
        </div>
      ),
    },
    {
      key: 'where',
      header: 'Where',
      render: (r) => (
        <span className="text-sm text-text-secondary">
          {[r.city, r.region, r.country].filter(Boolean).join(', ') || 'Not recorded'}
        </span>
      ),
    },
    {
      key: 'legal',
      header: 'Legal type',
      render: (r) => {
        const text = legalTypeSummary(r);
        return (
          <span className={text ? 'text-sm text-text-primary' : 'text-sm text-text-muted'}>
            {text ?? 'Not on record'}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>
            {access.mayEdit ? 'Change' : 'History'}
          </Button>
        </div>
      ),
    },
  ];

  if (!access.known || !access.mayRead) {
    return (
      <div className="space-y-6">
        <PageHeader title="Cinema legal types" />
        <Card>
          <p className="text-sm text-text-secondary">
            {access.known ? NO_READ_ACCESS : 'Loading...'}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Cinema pricing', href: '/admin/cinema-pricing' },
          { label: 'Cinema legal types' },
        ]}
        title="Cinema legal types"
        description="Local body, format and cooling for each cinema. A state's price order uses them to set the highest ticket price, so only the platform team sets them. Every change is recorded."
      />
      {!access.mayEdit && <p className="text-sm text-text-secondary">{READ_ONLY_NOTE}</p>}

      <Card>
        <SearchInput
          value={q}
          onChange={setQ}
          onSubmit={() => {
            setApplied(q.trim());
            setPage(1);
          }}
          placeholder="Search cinema, organizer, city or state"
        />
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={data?.data}
          rowKey={(r) => r.id}
          loading={isLoading}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
          empty={<EmptyState title="No cinema matches" hint="Try another search." />}
        />
        {data && data.meta.totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              onChange={setPage}
            />
          </div>
        )}
      </Card>

      {editing && (
        <LegalTypeDialog
          cinema={editing}
          mayEdit={access.mayEdit}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function LegalTypeDialog({
  cinema,
  mayEdit,
  onClose,
}: {
  cinema: AdminCinemaRow;
  mayEdit: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    localBodyType: cinema.localBodyType ?? '',
    cinemaFormat: cinema.cinemaFormat ?? '',
    climateType: cinema.climateType ?? '',
    reason: '',
  });
  const [error, setError] = useState('');
  const unchanged =
    form.localBodyType === (cinema.localBodyType ?? '') &&
    form.cinemaFormat === (cinema.cinemaFormat ?? '') &&
    form.climateType === (cinema.climateType ?? '');

  const save = useMutation({
    mutationFn: () =>
      api.admin.setCinemaLegalType(cinema.id, {
        localBodyType: (form.localBodyType || null) as CinemaLegalTypeBody['localBodyType'],
        cinemaFormat: (form.cinemaFormat || null) as CinemaLegalTypeBody['cinemaFormat'],
        climateType: (form.climateType || null) as CinemaLegalTypeBody['climateType'],
        reason: form.reason.trim(),
      }),
    onSuccess: () => {
      toast.push(`Legal type saved for ${cinema.name}.`, 'success');
      void qc.invalidateQueries({ queryKey: ['admin', 'cinemas'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const submit = () => {
    if (form.reason.trim().length < 5) {
      setError('Say why, for the record. For example: "Checked against the licence".');
      return;
    }
    setError('');
    save.mutate();
  };

  const where = [cinema.city, cinema.region, cinema.country].filter(Boolean).join(', ');
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Legal type: ${cinema.name}`}
      description={`${cinema.organization.name}${where ? ` - ${where}` : ''}`}
      footer={
        mayEdit ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} loading={save.isPending} disabled={unchanged}>
              Save legal type
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {mayEdit ? (
          <>
            <p className="text-sm text-text-secondary">
              This changes the highest price this cinema&apos;s tickets may be sold at, from the
              next sale. Tickets already sold keep their price.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Select
                id="legal-local-body"
                label="Local body"
                value={form.localBodyType}
                onChange={(e) => setForm({ ...form, localBodyType: e.target.value })}
              >
                <option value="">Not set</option>
                {LOCAL_BODY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Select
                id="legal-format"
                label="Format"
                value={form.cinemaFormat}
                onChange={(e) => setForm({ ...form, cinemaFormat: e.target.value })}
              >
                <option value="">Not set</option>
                {FORMAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Select
                id="legal-cooling"
                label="Cooling"
                value={form.climateType}
                onChange={(e) => setForm({ ...form, climateType: e.target.value })}
              >
                <option value="">Not set</option>
                {CLIMATE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <Textarea
              id="legal-reason"
              label="Why (kept on the record)"
              rows={2}
              value={form.reason}
              error={error || undefined}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </>
        ) : (
          <p className="text-sm text-text-primary">{legalTypeSummary(cinema) ?? 'Not on record'}</p>
        )}
        <RecordHistory subjects={[`Cinema:${cinema.id}`]} title="Changes so far" />
      </div>
    </Dialog>
  );
}
