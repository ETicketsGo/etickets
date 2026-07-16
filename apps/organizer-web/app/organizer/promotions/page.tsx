'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Input,
  Select,
  StatusBadge,
  PageHeader,
  Pagination,
  money,
  dateOnly,
  useToast,
  errorMessage,
  type Column,
  type Coupon,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

interface FormState {
  code: string;
  type: 'PERCENT' | 'FIXED';
  value: string;
  maxRedemptions: string;
  startsAt: string;
  endsAt: string;
}
const EMPTY: FormState = {
  code: '',
  type: 'PERCENT',
  value: '',
  maxRedemptions: '',
  startsAt: '',
  endsAt: '',
};

export default function PromotionsPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Coupon | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['coupons', activeOrg.id] });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['coupons', activeOrg.id, page],
    queryFn: () => api.coupons.list(activeOrg.id, { page, pageSize: 20 }),
  });

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (dialog === 'create') {
      if (!/^[A-Za-z0-9_-]{3,40}$/.test(form.code.trim()))
        e.code = '3–40 letters, numbers, hyphen or underscore.';
    }
    const v = Number(form.value);
    if (form.value === '' || !Number.isInteger(v) || v <= 0) e.value = 'Enter a whole number > 0.';
    else if (form.type === 'PERCENT' && v > 100) e.value = 'Percentage must be 1–100.';
    if (form.maxRedemptions && Number(form.maxRedemptions) <= 0)
      e.maxRedemptions = 'Must be greater than 0.';
    if (form.startsAt && form.endsAt && new Date(form.endsAt) < new Date(form.startsAt))
      e.endsAt = 'End must be on or after start.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = useMutation({
    mutationFn: async () => {
      const iso = (s: string) => (s ? new Date(s).toISOString() : undefined);
      if (dialog === 'create') {
        return api.coupons.create({
          organizationId: activeOrg.id,
          code: form.code.trim(),
          type: form.type,
          value: Number(form.value),
          maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : undefined,
          startsAt: iso(form.startsAt),
          endsAt: iso(form.endsAt),
        });
      }
      return api.coupons.update(editing!.id, {
        value: Number(form.value),
        maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : null,
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
      });
    },
    onSuccess: () => {
      toast.push(
        dialog === 'create' ? 'Discount code created.' : 'Discount code updated.',
        'success',
      );
      setDialog(null);
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const toggleStatus = useMutation({
    mutationFn: (c: Coupon) =>
      api.coupons.update(c.id, { status: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
    onSuccess: () => {
      toast.push('Status updated.', 'success');
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: (c: Coupon) => api.coupons.remove(c.id),
    onSuccess: () => {
      toast.push('Discount code deleted.', 'success');
      setDeleting(null);
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setErrors({});
    setDialog('create');
  };
  const openEdit = (c: Coupon) => {
    setEditing(c);
    setForm({
      code: c.code,
      type: c.type,
      value: String(c.value),
      maxRedemptions: c.maxRedemptions != null ? String(c.maxRedemptions) : '',
      startsAt: c.startsAt ? c.startsAt.slice(0, 10) : '',
      endsAt: c.endsAt ? c.endsAt.slice(0, 10) : '',
    });
    setErrors({});
    setDialog('edit');
  };
  const submit = () => {
    if (validate()) save.mutate();
  };

  const columns: Column<Coupon>[] = [
    {
      key: 'code',
      header: 'Code',
      render: (c) => <span className="font-mono font-medium">{c.code}</span>,
    },
    {
      key: 'discount',
      header: 'Discount',
      render: (c) => (c.type === 'PERCENT' ? `${c.value}%` : money(c.value)),
    },
    {
      key: 'used',
      header: 'Redemptions',
      render: (c) => `${c.redemptions}${c.maxRedemptions != null ? ` / ${c.maxRedemptions}` : ''}`,
    },
    {
      key: 'window',
      header: 'Window',
      render: (c) =>
        c.startsAt || c.endsAt
          ? `${c.startsAt ? dateOnly(c.startsAt) : '…'} – ${c.endsAt ? dateOnly(c.endsAt) : '…'}`
          : 'Always',
    },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    {
      key: 'actions',
      header: '',
      render: (c) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => openEdit(c)}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            loading={toggleStatus.isPending}
            onClick={() => toggleStatus.mutate(c)}
          >
            {c.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={c.redemptions > 0}
            title={
              c.redemptions > 0
                ? 'Redeemed codes cannot be deleted — deactivate instead.'
                : undefined
            }
            onClick={() => setDeleting(c)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Promotions"
        description="Create and manage discount codes buyers can apply at checkout."
        action={<Button onClick={openCreate}>New discount code</Button>}
      />

      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(c) => c.id}
        loading={isLoading}
        error={isError ? 'We couldn’t load discount codes.' : undefined}
        onRetry={refetch}
        empty={
          <EmptyState
            title="No discount codes yet"
            hint="Create a code to offer a percentage or fixed discount at checkout."
          />
        }
      />
      {data && data.meta.totalPages > 1 && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === 'create' ? 'New discount code' : 'Edit discount code'}
      >
        <div className="space-y-4">
          {dialog === 'create' ? (
            <Input
              id="code"
              label="Code"
              placeholder="SUMMER25"
              value={form.code}
              error={errors.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          ) : (
            <p className="text-caption text-text-muted">
              Code <span className="font-mono font-medium text-text-primary">{editing?.code}</span>{' '}
              (the code and type can’t be changed).
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Select
              id="type"
              label="Type"
              value={form.type}
              disabled={dialog === 'edit'}
              onChange={(e) => setForm({ ...form, type: e.target.value as FormState['type'] })}
            >
              <option value="PERCENT">Percentage</option>
              <option value="FIXED">Fixed amount</option>
            </Select>
            <Input
              id="value"
              label={form.type === 'PERCENT' ? 'Percent (1–100)' : 'Amount (₹)'}
              type="number"
              value={form.value}
              error={errors.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
            />
          </div>
          <Input
            id="max"
            label="Max redemptions (optional)"
            type="number"
            value={form.maxRedemptions}
            error={errors.maxRedemptions}
            onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              id="startsAt"
              label="Starts (optional)"
              type="date"
              value={form.startsAt}
              onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
            />
            <Input
              id="endsAt"
              label="Ends (optional)"
              type="date"
              value={form.endsAt}
              error={errors.endsAt}
              onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={submit}>
              {dialog === 'create' ? 'Create' : 'Save'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete discount code?"
      >
        <div className="space-y-4">
          <p className="text-[0.9375rem] text-text-secondary">
            Delete <span className="font-mono font-medium">{deleting?.code}</span>? This can’t be
            undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(deleting!)}
            >
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
