'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  DataTable,
  StatusBadge,
  PageHeader,
  useToast,
  errorMessage,
  type Column,
  type OrgMember,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

const ROLES = ['ORGANIZER_MANAGER', 'CHECKIN_STAFF', 'ORGANIZER_OWNER'];

/** What each role can actually do, said plainly at the point the choice is made. */
const ROLE_HELP: Record<string, string> = {
  ORGANIZER_OWNER: 'Everything, including team, payouts and legal details.',
  ORGANIZER_MANAGER: 'Create and run events. Cannot change the team or payout details.',
  CHECKIN_STAFF: 'Scan tickets at the door. No access to sales, money or settings.',
};

export default function TeamPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('CHECKIN_STAFF');

  /*
    The link for the person who was just invited, or whose link was just re-issued.

    Shown rather than only emailed, and this is not belt-and-braces — `EMAIL_PROVIDER=log`
    swallows mail in every environment configured so far, so for now the copied link IS the
    delivery mechanism. Kept in component state on purpose: it is a one-time secret, and
    re-fetching the member list must not reproduce it.
  */
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['members', activeOrg.id],
    queryFn: () => api.organizations.members(activeOrg.id),
  });

  const invite = useMutation({
    mutationFn: () => api.organizations.invite(activeOrg.id, { email, role }),
    onSuccess: (member) => {
      toast.push('Invitation created. Send them the link.', 'success');
      setLink({ email: member.user.email, url: member.inviteUrl });
      setEmail('');
      qc.invalidateQueries({ queryKey: ['members', activeOrg.id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const resend = useMutation({
    mutationFn: (memberId: string) => api.organizations.resendInvite(activeOrg.id, memberId),
    onSuccess: (r) => {
      toast.push('New link created. The previous one no longer works.', 'success');
      setLink({ email: r.email, url: r.inviteUrl });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<OrgMember>[] = [
    { key: 'name', header: 'Name', render: (m) => m.user.fullName },
    { key: 'email', header: 'Email', render: (m) => m.user.email },
    { key: 'role', header: 'Role', render: (m) => m.role.replaceAll('_', ' ') },
    {
      key: 'status',
      header: 'Status',
      /*
        INVITED means "cannot do anything yet", and that is worth saying out loud. Every
        member invited before this existed is sitting at INVITED with no way in, so the
        status needs to carry its own remedy rather than just its name.
      */
      render: (m) => (
        <div className="space-y-1">
          <StatusBadge status={m.status} />
          {m.status === 'INVITED' && (
            <>
              <p className="text-caption text-text-muted">Hasn&rsquo;t joined yet</p>
              <button
                type="button"
                disabled={resend.isPending}
                onClick={() => resend.mutate(m.id)}
                className="rounded text-caption text-action-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              >
                Get invite link
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <PageHeader title="Team" description="People who can manage this organization." />

        {link && (
          <Card>
            <h2 className="text-title font-semibold text-text-primary">
              Send this link to {link.email}
            </h2>
            <p className="mt-1 text-[0.9375rem] text-text-secondary">
              They open it to set a password and join. It works once and expires in seven days.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/*
                Readable and selectable rather than a bare "Copy" button. Clipboard access is
                blocked in plenty of contexts, and a link somebody cannot see is one they
                cannot send by hand when it fails.
              */}
              <input
                readOnly
                aria-label="Invitation link"
                value={link.url}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-md border border-border bg-background-canvas px-3 py-2 font-mono text-caption text-text-primary"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link.url);
                    toast.push('Link copied.', 'success');
                  } catch {
                    toast.push('Copy failed — select the link and copy it manually.', 'error');
                  }
                }}
              >
                Copy
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setLink(null)}>
                Done
              </Button>
            </div>
          </Card>
        )}

        <DataTable
          columns={columns}
          rows={data}
          loading={isLoading}
          rowKey={(m) => m.id}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
        />
      </div>

      <Card title="Add someone">
        <div className="space-y-3">
          <Input
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div>
            <Select id="role" label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.replaceAll('_', ' ')}
                </option>
              ))}
            </Select>
            {/* The permission is the decision being made here; naming it beats a role code. */}
            <p className="mt-1.5 text-caption text-text-muted">{ROLE_HELP[role]}</p>
          </div>
          <Button
            className="w-full"
            loading={invite.isPending}
            disabled={!email}
            onClick={() => invite.mutate()}
          >
            Create invitation
          </Button>
          <p className="text-caption text-text-muted">
            They don&rsquo;t need an account first — the link creates one.
          </p>
        </div>
      </Card>
    </div>
  );
}
