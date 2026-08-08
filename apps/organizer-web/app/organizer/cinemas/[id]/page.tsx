'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  api,
  Badge,
  Button,
  ButtonLink,
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

/**
 * Operational states, mirroring the backend enum exactly. There is no second screen-state
 * system: these strings are the ones the API accepts.
 */
type ScreenStatusValue = 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE';

const STATUS_LABEL: Record<ScreenStatusValue, string> = {
  ACTIVE: 'In service',
  MAINTENANCE: 'Maintenance',
  INACTIVE: 'Out of use',
};

const STATUS_TONE: Record<ScreenStatusValue, 'success' | 'warning' | 'neutral'> = {
  ACTIVE: 'success',
  MAINTENANCE: 'warning',
  INACTIVE: 'neutral',
};

/** What each state actually does, stated in the confirmation so nobody has to guess. */
const STATUS_EFFECT: Record<ScreenStatusValue, string[]> = {
  ACTIVE: ['New shows can be scheduled on this screen again.'],
  MAINTENANCE: [
    'New shows cannot be scheduled on this screen.',
    'Shows already scheduled are NOT cancelled — they stay on sale and need your review.',
    'Nothing is refunded and no customer is notified by this change.',
  ],
  INACTIVE: [
    'The screen cannot be used for any new scheduling.',
    'Shows already scheduled are NOT cancelled.',
    'All past bookings and history are kept.',
  ],
};

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

  /**
   * Take a screen in or out of service.
   *
   * Deliberately its own mutation rather than folded into the edit form: the edit form is
   * about what a screen IS (name, type, capacity), and this is about whether it can be
   * used. Mixing them would let a rename quietly change operational state.
   */
  const [statusTarget, setStatusTarget] = useState<Screen | null>(null);
  const [nextStatus, setNextStatus] = useState<ScreenStatusValue>('MAINTENANCE');
  const [statusReason, setStatusReason] = useState('');

  const changeStatus = useMutation({
    mutationFn: () =>
      api.cinemas.updateScreen(statusTarget!.id, {
        name: statusTarget!.name,
        screenType: statusTarget!.screenType,
        capacity: statusTarget!.capacity,
        status: nextStatus,
        statusReason: statusReason.trim() || undefined,
      }),
    onSuccess: () => {
      toast.push(
        `${statusTarget?.name} is now ${STATUS_LABEL[nextStatus].toLowerCase()}.`,
        'success',
      );
      setStatusTarget(null);
      setStatusReason('');
      qc.invalidateQueries({ queryKey: ['cinema', id, 'screens'] });
    },
    onError: (e) => {
      toast.push(errorMessage(e), 'error');
      // A timeout does not mean the write did not land; re-read rather than guess.
      qc.invalidateQueries({ queryKey: ['cinema', id, 'screens'] });
    },
  });

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
      key: 'status',
      header: 'Status',
      // Text, not a coloured dot: an operator scanning a list of screens must be able to
      // read the state without relying on hue.
      render: (s) => {
        const value = (s.status ?? 'ACTIVE') as ScreenStatusValue;
        const future = s.futureShowsRequiringAttention ?? 0;
        return (
          <span className="flex flex-col gap-0.5">
            <Badge tone={STATUS_TONE[value]}>{STATUS_LABEL[value]}</Badge>
            {value !== 'ACTIVE' && future > 0 ? (
              <span className="text-caption text-text-muted">
                {future} future show{future === 1 ? '' : 's'} need review
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      render: (s) => (
        <div className="flex justify-end gap-2">
          <ButtonLink
            variant="ghost"
            size="sm"
            href={`/organizer/cinemas/${id}/screens/${s.id}/seatmap`}
          >
            Seat map
          </ButtonLink>
          {/* The designer draws a room; this manages the versions the screen has had. */}
          <ButtonLink
            variant="ghost"
            size="sm"
            href={`/organizer/cinemas/${id}/screens/${s.id}/layouts`}
          >
            Layouts
          </ButtonLink>
          <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatusTarget(s);
              setNextStatus((s.status ?? 'ACTIVE') === 'ACTIVE' ? 'MAINTENANCE' : 'ACTIVE');
              setStatusReason('');
            }}
            aria-label={`Change status for ${s.name}`}
          >
            Change status
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

      {/*
        The operator's entry points into this cinema, in the order a day is actually run:
        plan the week, work tonight, review what was done. Plain links rather than a new
        navigation pattern — the shell's sidebar is organisation-level, and a cinema is not.
      */}
      <nav aria-label="Cinema operations" className="flex flex-wrap gap-2">
        <ButtonLink href={`/organizer/cinemas/${cinema.id}/schedule`} variant="secondary">
          Schedule
        </ButtonLink>
        <ButtonLink href={`/organizer/cinemas/${cinema.id}/live`} variant="secondary">
          Live operations
        </ButtonLink>
        <ButtonLink href={`/organizer/cinemas/${cinema.id}/reports`} variant="secondary">
          Override history
        </ButtonLink>
      </nav>

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

      {/*
        Taking a screen out of service is high-impact but NOT destructive, and the dialog
        says so explicitly. The single most important sentence here is that existing shows
        are not cancelled — an operator who assumes otherwise will not go and deal with them.
      */}
      <Dialog
        open={!!statusTarget}
        onClose={() => setStatusTarget(null)}
        title={statusTarget ? `Change status for ${statusTarget.name}` : 'Change status'}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setStatusTarget(null)}
              disabled={changeStatus.isPending}
            >
              Cancel
            </Button>
            <Button
              loading={changeStatus.isPending}
              disabled={changeStatus.isPending}
              onClick={() => changeStatus.mutate()}
            >
              {`Set ${STATUS_LABEL[nextStatus]}`}
            </Button>
          </>
        }
      >
        {statusTarget ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="screen-status" className="mb-1 block text-sm font-medium">
                New status
              </label>
              <Select
                id="screen-status"
                value={nextStatus}
                onChange={(e) => setNextStatus(e.target.value as ScreenStatusValue)}
              >
                <option value="ACTIVE">{STATUS_LABEL.ACTIVE}</option>
                <option value="MAINTENANCE">{STATUS_LABEL.MAINTENANCE}</option>
                <option value="INACTIVE">{STATUS_LABEL.INACTIVE}</option>
              </Select>
            </div>

            {(statusTarget.futureShowsRequiringAttention ?? 0) > 0 && nextStatus !== 'ACTIVE' ? (
              <p className="rounded-md bg-status-warning/10 p-3 text-sm" role="alert">
                <strong>
                  {statusTarget.name} has {statusTarget.futureShowsRequiringAttention} future show
                  {statusTarget.futureShowsRequiringAttention === 1 ? '' : 's'}.
                </strong>{' '}
                Changing it to {STATUS_LABEL[nextStatus].toLowerCase()} blocks new scheduling but
                will not cancel them. Review each one and cancel or move it yourself.
              </p>
            ) : null}

            <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">
              {STATUS_EFFECT[nextStatus].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>

            <div>
              <label htmlFor="screen-status-reason" className="mb-1 block text-sm font-medium">
                Reason (optional)
              </label>
              <Input
                id="screen-status-reason"
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                placeholder="e.g. projector replacement"
              />
              <p className="mt-1 text-caption text-text-muted">Recorded in the audit trail.</p>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
