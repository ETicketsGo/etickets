'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Plus, Pencil, Trash2, Package, Gift } from 'lucide-react';
import {
  api,
  Card,
  Button,
  Input,
  Textarea,
  Select,
  Dialog,
  DataTable,
  Skeleton,
  ErrorState,
  EmptyState,
  StatusBadge,
  useToast,
  errorMessage,
  money,
  type Column,
  type OrgAddOn,
  type AddOnInput,
  type AddOnType,
  type OrgBundle,
  type BundleInput,
  type BundleType,
  type BundlePricingKind,
} from '@eticketsgo/web-kit';

const ADD_ON_TYPES: AddOnType[] = [
  'MERCHANDISE',
  'PARKING',
  'FOOD_BEVERAGE',
  'VIP_UPGRADE',
  'MEET_GREET',
  'DONATION',
  'DIGITAL',
];
const BUNDLE_TYPES: BundleType[] = ['VIP', 'FAMILY', 'COMBO', 'EARLY_BIRD'];
const label = (s: string) =>
  s
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());

export default function CommerceTab() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-title font-semibold text-text-primary">Commerce</h2>
        <p className="mt-1 text-caption text-text-secondary">
          Sell add-ons and bundles alongside tickets — merchandise, parking, F&amp;B, upgrades,
          donations and more.
        </p>
      </div>
      <AddOnsSection eventId={id} />
      <BundlesSection eventId={id} />
    </div>
  );
}

// ─────────────────────────── Add-ons ───────────────────────────

const emptyAddOn: AddOnInput & { priceRupees: string; quantityText: string } = {
  type: 'MERCHANDISE',
  name: '',
  description: '',
  priceMinor: 0,
  priceRupees: '',
  quantityText: '',
  maxPerOrder: 10,
  imageUrl: '',
  enabled: true,
};

function AddOnsSection({ eventId }: { eventId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OrgAddOn | null>(null);
  const [form, setForm] = useState({ ...emptyAddOn });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['addons', eventId],
    queryFn: () => api.commerce.listAddOns(eventId),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['addons', eventId] });

  const openCreate = () => {
    setEditing(null);
    setForm({ ...emptyAddOn });
    setOpen(true);
  };
  const openEdit = (a: OrgAddOn) => {
    setEditing(a);
    setForm({
      type: a.type,
      name: a.name,
      description: a.description ?? '',
      priceMinor: a.priceMinor,
      priceRupees: String(a.priceMinor / 100),
      quantityText: a.inventory?.quantityTotal == null ? '' : String(a.inventory.quantityTotal),
      maxPerOrder: a.maxPerOrder,
      imageUrl: a.imageUrl ?? '',
      enabled: a.enabled,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: () => {
      const body: AddOnInput = {
        type: form.type,
        name: form.name.trim(),
        description: form.description?.trim() || undefined,
        priceMinor: Math.round(Number(form.priceRupees || 0) * 100),
        maxPerOrder: Number(form.maxPerOrder) || 1,
        imageUrl: form.imageUrl?.trim() || undefined,
        quantityTotal: form.quantityText.trim() === '' ? null : Number(form.quantityText),
        enabled: form.enabled,
      };
      return editing
        ? api.commerce.updateAddOn(editing.id, body)
        : api.commerce.createAddOn(eventId, body);
    },
    onSuccess: () => {
      toast.push(editing ? 'Add-on updated.' : 'Add-on created.', 'success');
      setOpen(false);
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const del = useMutation({
    mutationFn: (a: OrgAddOn) => api.commerce.deleteAddOn(a.id),
    onSuccess: () => {
      toast.push('Add-on deleted.', 'success');
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const cols: Column<OrgAddOn>[] = [
    {
      key: 'name',
      header: 'Add-on',
      render: (a) => (
        <div>
          <p className="font-medium text-text-primary">{a.name}</p>
          <p className="text-caption text-text-muted">{label(a.type)}</p>
        </div>
      ),
    },
    { key: 'price', header: 'Price', render: (a) => money(a.priceMinor) },
    {
      key: 'stock',
      header: 'Stock',
      render: (a) =>
        a.inventory?.quantityTotal == null
          ? 'Unlimited'
          : `${a.inventory.quantitySold}/${a.inventory.quantityTotal} sold`,
    },
    {
      key: 'status',
      header: 'Status',
      render: (a) => <StatusBadge status={a.enabled ? 'ACTIVE' : 'DISABLED'} />,
    },
    {
      key: 'actions',
      header: '',
      render: (a) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openEdit(a)}
            aria-label={`Edit ${a.name}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={del.isPending && del.variables?.id === a.id}
            onClick={() => del.mutate(a)}
            aria-label={`Delete ${a.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Card
      title="Add-ons"
      action={
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" /> New add-on
        </Button>
      }
    >
      {isError ? (
        <ErrorState message="Couldn't load add-ons." onRetry={() => refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Package}
          title="No add-ons yet"
          hint="Create merchandise, parking, F&B, upgrades or a donation option."
        />
      ) : (
        <DataTable columns={cols} rows={data!} rowKey={(a) => a.id} />
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit add-on' : 'New add-on'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              {editing ? 'Save' : 'Create'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Select
            id="ao-type"
            label="Type"
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as AddOnType }))}
          >
            {ADD_ON_TYPES.map((t) => (
              <option key={t} value={t}>
                {label(t)}
              </option>
            ))}
          </Select>
          <Input
            id="ao-name"
            label="Name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Textarea
            id="ao-desc"
            label="Description (optional)"
            rows={2}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              id="ao-price"
              label="Price (₹)"
              type="number"
              min={0}
              step="0.01"
              value={form.priceRupees}
              onChange={(e) => setForm((f) => ({ ...f, priceRupees: e.target.value }))}
            />
            <Input
              id="ao-qty"
              label="Stock (blank = unlimited)"
              type="number"
              min={0}
              value={form.quantityText}
              onChange={(e) => setForm((f) => ({ ...f, quantityText: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              id="ao-max"
              label="Max per order"
              type="number"
              min={1}
              value={form.maxPerOrder}
              onChange={(e) => setForm((f) => ({ ...f, maxPerOrder: Number(e.target.value) }))}
            />
            <Input
              id="ao-img"
              label="Image URL (optional)"
              value={form.imageUrl}
              onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            Enabled (available for purchase)
          </label>
        </div>
      </Dialog>
    </Card>
  );
}

// ─────────────────────────── Bundles ───────────────────────────

function BundlesSection({ eventId }: { eventId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OrgBundle | null>(null);
  const [form, setForm] = useState({
    type: 'COMBO' as BundleType,
    name: '',
    description: '',
    pricingKind: 'PERCENT_DISCOUNT' as BundlePricingKind,
    priceRupees: '',
    discountPercent: '10',
    maxPerOrder: 5,
    enabled: true,
  });
  const [qty, setQty] = useState<Record<string, number>>({});

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['bundles', eventId],
    queryFn: () => api.commerce.listBundles(eventId),
  });
  const eventQ = useQuery({ queryKey: ['event', eventId], queryFn: () => api.events.get(eventId) });
  const addOnsQ = useQuery({
    queryKey: ['addons', eventId],
    queryFn: () => api.commerce.listAddOns(eventId),
  });

  // Components available to bundle: ticket types (from sessions) + add-ons.
  const options = useMemo(() => {
    const tickets = (eventQ.data?.sessions ?? []).flatMap((s) =>
      (s.ticketTypes ?? []).map((t) => ({
        refId: t.id,
        kind: 'ticket' as const,
        label: t.name,
        priceMinor: t.priceMinor,
      })),
    );
    const addOns = (addOnsQ.data ?? []).map((a) => ({
      refId: a.id,
      kind: 'addon' as const,
      label: a.name,
      priceMinor: a.priceMinor,
    }));
    return [...tickets, ...addOns];
  }, [eventQ.data, addOnsQ.data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['bundles', eventId] });

  const openCreate = () => {
    setEditing(null);
    setForm({
      type: 'COMBO',
      name: '',
      description: '',
      pricingKind: 'PERCENT_DISCOUNT',
      priceRupees: '',
      discountPercent: '10',
      maxPerOrder: 5,
      enabled: true,
    });
    setQty({});
    setOpen(true);
  };
  const openEdit = (b: OrgBundle) => {
    setEditing(b);
    setForm({
      type: b.type,
      name: b.name,
      description: b.description ?? '',
      pricingKind: b.pricingKind,
      priceRupees: b.priceMinor == null ? '' : String(b.priceMinor / 100),
      discountPercent: b.discountPercent == null ? '10' : String(b.discountPercent),
      maxPerOrder: b.maxPerOrder,
      enabled: b.enabled,
    });
    setQty(Object.fromEntries(b.components.map((c) => [c.refId, c.quantity])));
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: () => {
      const items = options
        .filter((o) => (qty[o.refId] ?? 0) > 0)
        .map((o) =>
          o.kind === 'ticket'
            ? { ticketTypeId: o.refId, quantity: qty[o.refId] }
            : { addOnId: o.refId, quantity: qty[o.refId] },
        );
      const body: BundleInput = {
        type: form.type,
        name: form.name.trim(),
        description: form.description?.trim() || undefined,
        pricingKind: form.pricingKind,
        priceMinor:
          form.pricingKind === 'FIXED'
            ? Math.round(Number(form.priceRupees || 0) * 100)
            : undefined,
        discountPercent:
          form.pricingKind === 'PERCENT_DISCOUNT' ? Number(form.discountPercent || 0) : undefined,
        maxPerOrder: Number(form.maxPerOrder) || 1,
        enabled: form.enabled,
        items,
      };
      return editing
        ? api.commerce.updateBundle(editing.id, body)
        : api.commerce.createBundle(eventId, body);
    },
    onSuccess: () => {
      toast.push(editing ? 'Bundle updated.' : 'Bundle created.', 'success');
      setOpen(false);
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const del = useMutation({
    mutationFn: (b: OrgBundle) => api.commerce.deleteBundle(b.id),
    onSuccess: () => {
      toast.push('Bundle deleted.', 'success');
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const cols: Column<OrgBundle>[] = [
    {
      key: 'name',
      header: 'Bundle',
      render: (b) => (
        <div>
          <p className="font-medium text-text-primary">{b.name}</p>
          <p className="text-caption text-text-muted">
            {label(b.type)} · {b.components.length} item{b.components.length === 1 ? '' : 's'}
          </p>
        </div>
      ),
    },
    {
      key: 'price',
      header: 'Price',
      render: (b) => (
        <div>
          <span className="font-medium text-text-primary">{money(b.priceFromMinor)}</span>
          {b.savingsMinor > 0 && (
            <span className="ml-1 text-caption text-status-success">
              save {money(b.savingsMinor)}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (b) => <StatusBadge status={b.enabled ? 'ACTIVE' : 'DISABLED'} />,
    },
    {
      key: 'actions',
      header: '',
      render: (b) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openEdit(b)}
            aria-label={`Edit ${b.name}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={del.isPending && del.variables?.id === b.id}
            onClick={() => del.mutate(b)}
            aria-label={`Delete ${b.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Card
      title="Bundles"
      action={
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" /> New bundle
        </Button>
      }
    >
      {isError ? (
        <ErrorState message="Couldn't load bundles." onRetry={() => refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Gift}
          title="No bundles yet"
          hint="Package tickets and add-ons into a VIP, family or combo deal."
        />
      ) : (
        <DataTable columns={cols} rows={data!} rowKey={(b) => b.id} />
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit bundle' : 'New bundle'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              {editing ? 'Save' : 'Create'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Select
              id="b-type"
              label="Type"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as BundleType }))}
            >
              {BUNDLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
            <Input
              id="b-name"
              label="Name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <Textarea
            id="b-desc"
            label="Description (optional)"
            rows={2}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <Select
              id="b-pricing"
              label="Pricing"
              value={form.pricingKind}
              onChange={(e) =>
                setForm((f) => ({ ...f, pricingKind: e.target.value as BundlePricingKind }))
              }
            >
              <option value="PERCENT_DISCOUNT">% discount</option>
              <option value="FIXED">Fixed price</option>
            </Select>
            {form.pricingKind === 'FIXED' ? (
              <Input
                id="b-price"
                label="Bundle price (₹)"
                type="number"
                min={0}
                step="0.01"
                value={form.priceRupees}
                onChange={(e) => setForm((f) => ({ ...f, priceRupees: e.target.value }))}
              />
            ) : (
              <Input
                id="b-disc"
                label="Discount %"
                type="number"
                min={1}
                max={100}
                value={form.discountPercent}
                onChange={(e) => setForm((f) => ({ ...f, discountPercent: e.target.value }))}
              />
            )}
          </div>
          <Input
            id="b-max"
            label="Max per order"
            type="number"
            min={1}
            value={form.maxPerOrder}
            onChange={(e) => setForm((f) => ({ ...f, maxPerOrder: Number(e.target.value) }))}
          />

          <div>
            <p className="mb-2 text-caption font-medium text-text-secondary">
              Items in this bundle
            </p>
            {options.length === 0 ? (
              <p className="text-caption text-text-muted">
                Add ticket types or add-ons first, then build a bundle.
              </p>
            ) : (
              <div className="space-y-2">
                {options.map((o) => (
                  <div key={o.refId} className="flex items-center gap-3">
                    <span className="flex-1 text-sm text-text-primary">
                      {o.label}{' '}
                      <span className="text-text-muted">
                        ({o.kind}, {money(o.priceMinor)})
                      </span>
                    </span>
                    <input
                      type="number"
                      min={0}
                      className="w-20 rounded-lg border border-border-strong bg-surface-muted px-2 py-1 text-sm"
                      aria-label={`Quantity of ${o.label}`}
                      value={qty[o.refId] ?? 0}
                      onChange={(e) =>
                        setQty((q) => ({ ...q, [o.refId]: Math.max(0, Number(e.target.value)) }))
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            Enabled (available for purchase)
          </label>
        </div>
      </Dialog>
    </Card>
  );
}
