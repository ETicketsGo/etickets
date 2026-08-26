'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ShieldCheck, UserPlus, UserMinus } from 'lucide-react';
import {
  api,
  Button,
  Card,
  Dialog,
  ErrorState,
  PageHeader,
  SearchInput,
  Skeleton,
  useToast,
  errorMessage,
  type AdminStaffMember,
} from '@eticketsgo/web-kit';

/**
 * Who works in the back office, and what each of them may do.
 *
 * ── WHAT THIS SCREEN IS FOR ────────────────────────────────────────────────────────
 * Until recently there was one admin role and every admin route accepted it, so anybody
 * who could reach this console could do everything on it. Duties are now named
 * capabilities, and this is where they are handed out.
 *
 * The screen leans on two things being visible rather than implied: that a super admin
 * holds everything by role (so their list is not editable and saying so beats showing an
 * empty box), and that granting `ADMIN_MANAGE` effectively grants everything, because an
 * account that can change permissions can change its own.
 */
const RISKY = new Set(['ADMIN_MANAGE', 'REFUND_APPROVE', 'PLATFORM_CONFIG', 'PAYOUT_MANAGE']);

/**
 * What a brand-new back-office account starts with: nothing.
 *
 * Emphatically not a default bundle. The old behaviour was that every admin could do
 * everything, and a screen that pre-ticks a generous preset quietly restores it for anybody
 * who clicks through without reading. Whoever adds the person picks the duties on purpose.
 */
const ADD_DEFAULT: string[] = [];

/** Turns REFUND_APPROVE into "Refund approve" — readable without a translation table. */
const humanise = (permission: string) =>
  permission.charAt(0) + permission.slice(1).toLowerCase().replace(/_/g, ' ');

export default function StaffPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<AdminStaffMember | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');

  const staffQ = useQuery({ queryKey: ['admin', 'staff'], queryFn: () => api.admin.staff.list() });
  const catalogueQ = useQuery({
    queryKey: ['admin', 'staff', 'catalogue'],
    queryFn: () => api.admin.staff.catalogue(),
  });

  /*
    Finding somebody to promote.

    Deliberately a search over EXISTING accounts rather than a "create admin" form. An
    admin is a real person who already signed up and chose their own password; minting
    credentials here would mean this screen handing out passwords that the account holder
    never picked and an administrator has seen.
  */
  const candidatesQ = useQuery({
    queryKey: ['admin', 'users', search],
    queryFn: () => api.users.adminList({ page: 1, pageSize: 10, q: search }),
    enabled: adding && search.trim().length >= 2,
  });

  const promote = useMutation({
    mutationFn: (userId: string) => api.admin.staff.grantAdminRole(userId, [...selected]),
    onSuccess: () => {
      toast.push('Back-office access granted.', 'success');
      qc.invalidateQueries({ queryKey: ['admin', 'staff'] });
      setAdding(false);
      setSearch('');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const revoke = useMutation({
    mutationFn: (userId: string) => api.admin.staff.revoke(userId),
    onSuccess: () => {
      toast.push('Back-office access removed.', 'success');
      qc.invalidateQueries({ queryKey: ['admin', 'staff'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  useEffect(() => {
    if (adding) setSelected(new Set(ADD_DEFAULT));
  }, [adding]);

  useEffect(() => {
    if (editing) {
      setSelected(new Set(editing.permissions));
      setNote('');
    }
  }, [editing]);

  const save = useMutation({
    mutationFn: () => api.admin.staff.setPermissions(editing!.id, [...selected], note || undefined),
    onSuccess: () => {
      toast.push(`Permissions updated for ${editing?.email}.`, 'success');
      qc.invalidateQueries({ queryKey: ['admin', 'staff'] });
      setEditing(null);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const toggle = (permission: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Back-office staff"
          description="Who can reach this console, and exactly what each of them may do."
        />
        <Button onClick={() => setAdding(true)}>
          <UserPlus className="mr-1.5 h-4 w-4" /> Add staff
        </Button>
      </div>

      {staffQ.isError ? (
        <ErrorState
          message="We couldn't load staff. Please try again."
          onRetry={() => staffQ.refetch()}
        />
      ) : staffQ.isLoading || !staffQ.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-3">
          {staffQ.data.map((person) => (
            <Card key={person.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-text-primary">
                    {person.fullName}
                    {person.isSuperAdmin ? (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-action-primary/10 px-2 py-0.5 text-caption font-medium text-action-primary">
                        <ShieldCheck className="h-3 w-3" /> Super admin
                      </span>
                    ) : null}
                  </p>
                  <p className="text-caption text-text-muted">{person.email}</p>
                </div>
                {person.isSuperAdmin ? (
                  /*
                    Not editable, and the reason is written out rather than left as a
                    disabled control. A super admin holds everything BY ROLE — showing them
                    an empty permission list would read as "can do nothing", which is the
                    exact opposite of the truth.
                  */
                  <span className="text-caption text-text-muted">
                    Holds every permission. Change this at the database level, deliberately.
                  </span>
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(person)}>
                      Change duties
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={revoke.isPending && revoke.variables === person.id}
                      onClick={() => revoke.mutate(person.id)}
                      className="text-status-error"
                    >
                      <UserMinus className="mr-1.5 h-4 w-4" /> Remove access
                    </Button>
                  </div>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {person.permissions.length === 0 ? (
                  <span className="text-caption text-text-muted">
                    No duties assigned — can sign in and see nothing.
                  </span>
                ) : (
                  person.permissions.map((p) => (
                    <span
                      key={p}
                      className={`rounded-full px-2 py-0.5 text-caption ${
                        RISKY.has(p)
                          ? 'bg-status-warning/10 text-text-primary'
                          : 'bg-background-subtle text-text-secondary'
                      }`}
                    >
                      {humanise(p)}
                    </span>
                  ))
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Duties for ${editing.fullName}` : 'Duties'}
      >
        {editing ? (
          <div className="space-y-4">
            <DutyChecklist
              catalogue={catalogueQ.data}
              selected={selected}
              toggle={toggle}
              setSelected={setSelected}
            />

            <input
              aria-label="Why"
              placeholder="Why (optional) — a ticket, an approval, a rota"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-md border border-border bg-background-surface px-3 py-2 text-[0.9375rem] text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button loading={save.isPending} onClick={() => save.mutate()}>
                Save duties
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add back-office staff">
        <div className="space-y-4">
          <div>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Find someone by name or email…"
            />
            <p className="mt-1.5 text-caption text-text-muted">
              {/*
                Said out loud, because "add staff" usually means "create an account" and it
                does not here. The person has to already have signed up — we never set
                somebody else's password.
              */}
              They need an ETicketsGo account already. Pick the duties below, then choose who gets
              them.
            </p>
          </div>

          <DutyChecklist
            catalogue={catalogueQ.data}
            selected={selected}
            toggle={toggle}
            setSelected={setSelected}
          />

          <div className="space-y-1">
            {search.trim().length < 2 ? (
              <p className="text-caption text-text-muted">
                Type at least two characters to search.
              </p>
            ) : candidatesQ.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : (candidatesQ.data?.data ?? []).length === 0 ? (
              <p className="text-caption text-text-muted">
                Nobody matches “{search}”. They may not have signed up yet.
              </p>
            ) : (
              candidatesQ.data!.data.map((u) => {
                const already = u.roles.includes('ADMIN') || u.roles.includes('SUPER_ADMIN');
                return (
                  <div
                    key={u.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[0.9375rem] text-text-primary">{u.fullName}</p>
                      <p className="truncate text-caption text-text-muted">{u.email}</p>
                    </div>
                    {already ? (
                      // Shown rather than hidden: a person searching for somebody who is
                      // already staff needs to know that, not to wonder why they vanished.
                      <span className="shrink-0 text-caption text-text-muted">Already staff</span>
                    ) : (
                      <Button
                        size="sm"
                        loading={promote.isPending && promote.variables === u.id}
                        onClick={() => promote.mutate(u.id)}
                      >
                        Grant access
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * The duty checklist, shared by "add staff" and "change duties".
 *
 * One component rather than two copies, because a warning that appears on one screen and
 * not the other is worse than no warning: it teaches that the absence of one means safe.
 */
function DutyChecklist({
  catalogue,
  selected,
  toggle,
  setSelected,
}: {
  catalogue?: {
    permissions: string[];
    presets: { key: string; label: string; description: string; grants: string[] }[];
  };
  selected: Set<string>;
  toggle: (permission: string) => void;
  setSelected: (next: Set<string>) => void;
}) {
  return (
    <>
      {/*
          Presets first, because the common case is "make this person a refund desk"
          and nobody should have to know which twelve boxes that means. They only fill
          the checkboxes in — what gets saved is always the explicit set below, so
          editing a preset later never silently changes what somebody already holds.
        */}
      {(catalogue?.presets ?? []).length > 0 && (
        <div>
          <p className="mb-2 text-caption font-medium text-text-secondary">Start from</p>
          <div className="flex flex-wrap gap-2">
            {catalogue!.presets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                title={preset.description}
                onClick={() => setSelected(new Set(preset.grants))}
                className="rounded-md border border-border px-2.5 py-1 text-caption text-text-primary transition-colors hover:bg-background-subtle"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="max-h-72 space-y-1.5 overflow-auto">
        {(catalogue?.permissions ?? []).map((permission) => (
          <label
            key={permission}
            className="flex cursor-pointer items-start gap-2.5 rounded-md p-1.5 hover:bg-background-subtle"
          >
            <input
              type="checkbox"
              checked={selected.has(permission)}
              onChange={() => toggle(permission)}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-action-primary"
            />
            <span className="min-w-0">
              <span className="text-[0.9375rem] text-text-primary">{humanise(permission)}</span>
              {permission === 'ADMIN_MANAGE' ? (
                <span className="block text-caption text-status-warning">
                  Grants everything in practice — this person could then give themselves any other
                  duty.
                </span>
              ) : permission === 'REFUND_APPROVE' ? (
                <span className="block text-caption text-text-muted">
                  Moves money, and it does not come back. Reviewing a refund is a separate duty.
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
    </>
  );
}
