'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  Dialog,
  DataTable,
  Skeleton,
  ErrorState,
  PageHeader,
  useToast,
  errorMessage,
  type Column,
  type Screen,
  type ScreenBody,
  type CinemaBody,
} from '@eticketsgo/web-kit';

const SCREEN_TYPES = ['2D', '3D', 'IMAX', '4DX', 'Dolby Atmos', 'Recliner'];

interface ScreenDraft {
  name: string;
  screenType: string;
  capacity: string;
}

const emptyDraft: ScreenDraft = { name: '', screenType: '2D', capacity: '' };

export default function CinemaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();

  const cinemaQ = useQuery({ queryKey: ['cinema', id], queryFn: () => api.cinemas.get(id) });
  const screensQ = useQuery({
    queryKey: ['cinema', id, 'screens'],
    queryFn: () => api.cinemas.screens(id),
  });

  const [form, setForm] = useState({
    name: '',
    brand: '',
    city: '',
    address: '',
    latitude: '',
    longitude: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const c = cinemaQ.data;
    if (c)
      setForm({
        name: c.name,
        brand: c.brand ?? '',
        city: c.city,
        address: c.address ?? '',
        latitude: c.latitude != null ? String(c.latitude) : '',
        longitude: c.longitude != null ? String(c.longitude) : '',
      });
  }, [cinemaQ.data]);

  const setField = (key: keyof typeof form, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (form.name.trim().length < 2) e.name = 'Name must be at least 2 characters.';
    if (!form.city.trim()) e.city = 'City is required.';
    return e;
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Partial<CinemaBody> = {
        name: form.name.trim(),
        brand: form.brand.trim() || undefined,
        city: form.city.trim(),
        address: form.address.trim() || undefined,
        latitude: form.latitude ? Number(form.latitude) : undefined,
        longitude: form.longitude ? Number(form.longitude) : undefined,
      };
      return api.cinemas.update(id, body);
    },
    onSuccess: () => {
      toast.push('Cinema updated.', 'success');
      qc.invalidateQueries({ queryKey: ['cinema', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const submit = () => {
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    save.mutate();
  };

  // Screen dialog state (add + edit share one dialog).
  const [screenOpen, setScreenOpen] = useState(false);
  const [editingScreen, setEditingScreen] = useState<Screen | null>(null);
  const [draft, setDraft] = useState<ScreenDraft>(emptyDraft);
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<Screen | null>(null);

  const openAdd = () => {
    setEditingScreen(null);
    setDraft(emptyDraft);
    setDraftErrors({});
    setScreenOpen(true);
  };
  const openEdit = (s: Screen) => {
    setEditingScreen(s);
    setDraft({ name: s.name, screenType: s.screenType, capacity: String(s.capacity) });
    setDraftErrors({});
    setScreenOpen(true);
  };

  const validateDraft = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (draft.name.trim().length < 1) e.name = 'Name is required.';
    const cap = Number(draft.capacity);
    if (!draft.capacity || !Number.isFinite(cap) || cap < 1)
      e.capacity = 'Capacity must be at least 1.';
    return e;
  };

  const saveScreen = useMutation({
    mutationFn: () => {
      const body: ScreenBody = {
        name: draft.name.trim(),
        screenType: draft.screenType,
        capacity: Number(draft.capacity),
      };
      return editingScreen
        ? api.cinemas.updateScreen(editingScreen.id, body)
        : api.cinemas.addScreen(id, body);
    },
    onSuccess: () => {
      toast.push(editingScreen ? 'Screen updated.' : 'Screen added.', 'success');
      qc.invalidateQueries({ queryKey: ['cinema', id, 'screens'] });
      qc.invalidateQueries({ queryKey: ['cinema', id] });
      setScreenOpen(false);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const submitScreen = () => {
    const errs = validateDraft();
    setDraftErrors(errs);
    if (Object.keys(errs).length > 0) return;
    saveScreen.mutate();
  };

  const removeScreen = useMutation({
    mutationFn: (screenId: string) => api.cinemas.removeScreen(screenId),
    onSuccess: () => {
      toast.push('Screen removed.', 'success');
      qc.invalidateQueries({ queryKey: ['cinema', id, 'screens'] });
      qc.invalidateQueries({ queryKey: ['cinema', id] });
      setRemoving(null);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const screenColumns: Column<Screen>[] = [
    { key: 'name', header: 'Name', render: (s) => s.name },
    { key: 'type', header: 'Type', render: (s) => s.screenType },
    { key: 'capacity', header: 'Capacity', render: (s) => s.capacity },
    {
      key: 'actions',
      header: '',
      render: (s) => (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error"
            onClick={() => setRemoving(s)}
          >
            Remove
          </Button>
        </div>
      ),
    },
  ];

  if (cinemaQ.isError)
    return (
      <ErrorState
        message="We couldn't load this. Please try again."
        onRetry={() => cinemaQ.refetch()}
      />
    );
  if (cinemaQ.isLoading || !cinemaQ.data) return <Skeleton className="h-64 w-full" />;

  const cinema = cinemaQ.data;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={cinema.name}
        breadcrumbs={[{ label: 'Cinemas', href: '/organizer/cinemas' }, { label: cinema.name }]}
      />

      <Card title="Details">
        <div className="space-y-4">
          <Input
            id="name"
            label="Name"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            error={fieldErrors.name}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="brand"
              label="Brand"
              value={form.brand}
              onChange={(e) => setField('brand', e.target.value)}
            />
            <Input
              id="city"
              label="City"
              value={form.city}
              onChange={(e) => setField('city', e.target.value)}
              error={fieldErrors.city}
            />
          </div>
          <Input
            id="address"
            label="Address"
            value={form.address}
            onChange={(e) => setField('address', e.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="latitude"
              label="Latitude"
              value={form.latitude}
              onChange={(e) => setField('latitude', e.target.value)}
            />
            <Input
              id="longitude"
              label="Longitude"
              value={form.longitude}
              onChange={(e) => setField('longitude', e.target.value)}
            />
          </div>
          <Button loading={save.isPending} onClick={submit}>
            Save changes
          </Button>
        </div>
      </Card>

      <Card
        title="Screens"
        action={
          <Button size="sm" onClick={openAdd}>
            Add screen
          </Button>
        }
      >
        <DataTable
          columns={screenColumns}
          rows={screensQ.data}
          loading={screensQ.isLoading}
          error={screensQ.isError ? "We couldn't load screens. Please try again." : undefined}
          onRetry={() => screensQ.refetch()}
          rowKey={(s) => s.id}
          empty={
            <div className="p-8 text-center text-text-muted">
              No screens yet. Add a screen to define seating capacity.
            </div>
          }
        />
      </Card>

      <Dialog
        open={screenOpen}
        onClose={() => setScreenOpen(false)}
        title={editingScreen ? 'Edit screen' : 'Add screen'}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setScreenOpen(false)}
              disabled={saveScreen.isPending}
            >
              Cancel
            </Button>
            <Button loading={saveScreen.isPending} onClick={submitScreen}>
              {editingScreen ? 'Save screen' : 'Add screen'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            id="screenName"
            label="Name"
            autoFocus
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            error={draftErrors.name}
          />
          <Select
            id="screenType"
            label="Screen type"
            value={draft.screenType}
            onChange={(e) => setDraft({ ...draft, screenType: e.target.value })}
          >
            {SCREEN_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Input
            id="screenCapacity"
            label="Capacity"
            type="number"
            min={1}
            value={draft.capacity}
            onChange={(e) => setDraft({ ...draft, capacity: e.target.value })}
            error={draftErrors.capacity}
          />
        </div>
      </Dialog>

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove screen?"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setRemoving(null)}
              disabled={removeScreen.isPending}
            >
              Cancel
            </Button>
            <Button
              loading={removeScreen.isPending}
              onClick={() => removing && removeScreen.mutate(removing.id)}
            >
              Remove
            </Button>
          </>
        }
      >
        This permanently removes the screen {removing ? `"${removing.name}"` : ''} from{' '}
        {cinema.name}. This cannot be undone.
      </Dialog>
    </div>
  );
}
