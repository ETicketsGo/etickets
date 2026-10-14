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
  BrandStatusPill,
  PageHeader,
  dateOnly,
  useToast,
  errorMessage,
  type Column,
  type OrgMember,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { isForbidden } from '@/lib/org-permissions';

const ROLES = ['ORGANIZER_MANAGER', 'CHECKIN_STAFF', 'ORGANIZER_OWNER'];

/** A role as a person says it. The API's codes (ORGANIZER_MANAGER) are not words. */
const ROLE_NAME: Record<string, string> = {
  ORGANIZER_OWNER: 'Owner',
  ORGANIZER_MANAGER: 'Manager',
  CHECKIN_STAFF: 'Check-in staff',
};
const roleName = (r: string) => ROLE_NAME[r] ?? r.replaceAll('_', ' ').toLowerCase();

/** What each role can actually do, said plainly at the point the choice is made. */
const ROLE_HELP: Record<string, string> = {
  ORGANIZER_OWNER: 'Everything, including team, payouts and legal details.',
  ORGANIZER_MANAGER: 'Create and run events. Cannot change the team or payout details.',
  CHECKIN_STAFF: 'Scan tickets at the door. No access to sales, money or settings.',
};

/**
 * The member row, with the one field the list already carries but the type did not name.
 *
 * `GET /organizations/:id/members` returns the membership row whole, so `createdAt` - when this
 * person was added - is in every response. Read, never required: an API that left it out shows
 * an empty cell, not a wrong date. "Last active" is not recorded for members, so it is not shown.
 */
type MemberRow = OrgMember & { createdAt?: string };

/** Initials for the row's avatar: "Meera Manager" is "MM". Decoration; the name is beside it. */
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((p) => p.match(/[\p{L}\p{N}]/u)?.[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

/**
 * An address that wraps at the "@" (and at dots in the domain) before it ever breaks a word:
 * `break-all` split "owner@etick|etsgo.test" mid-name at laptop widths.
 */
function EmailText({ email }: { email: string }) {
  const at = email.indexOf('@');
  if (at < 0) return <>{email}</>;
  const domain = email.slice(at + 1).split('.');
  return (
    <>
      {email.slice(0, at)}
      <wbr />@
      {domain.map((part, i) => (
        <span key={i}>
          {i > 0 && (
            <>
              <wbr />.
            </>
          )}
          {part}
        </span>
      ))}
    </>
  );
}

/** A status the API may add later, said in sentence case rather than as a code. */
const sentence = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replaceAll('_', ' ');

export default function TeamPage() {
  const { activeOrg, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('CHECKIN_STAFF');

  /*
    The link for the person who was just invited, or whose link was just re-issued.

    Shown rather than only emailed, and this is not belt-and-braces - `EMAIL_PROVIDER=log`
    swallows mail in every environment configured so far, so for now the copied link IS the
    delivery mechanism. Kept in component state on purpose: it is a one-time secret, and
    re-fetching the member list must not reproduce it.
  */
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);

  /*
    The member list is owners and managers only at the API. Check-in staff were sent the
    request and shown "We couldn't load this. Please try again." - a retry that can never
    succeed (found by QA). It is not requested for them, and the table says why instead.
  */
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['members', activeOrg.id],
    queryFn: () => api.organizations.members(activeOrg.id),
    enabled: can.financials,
  });
  const teamListRefused = !can.financials || isForbidden(error);

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

  const columns: Column<MemberRow>[] = [
    {
      key: 'name',
      header: 'Member',
      /*
        Name and email in one cell, the email under the name: two narrow columns wrapped every
        address mid-word at a laptop width, and the pair is one fact - who this is.
      */
      render: (m) => (
        <span className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full border border-brand-line bg-brand-sunken text-brand-meta font-semibold text-brand-ink-2 sm:flex"
          >
            {initials(m.user.fullName)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="break-words font-semibold text-brand-ink">{m.user.fullName}</span>
            <span className="break-words text-brand-meta text-brand-ink-2">
              <EmailText email={m.user.email} />
            </span>
          </span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (m) => <span className="whitespace-nowrap">{roleName(m.role)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      /*
        INVITED means "cannot do anything yet", and that is worth saying out loud. Every
        member invited before this existed is sitting at INVITED with no way in, so the
        status needs to carry its own remedy rather than just its name.
      */
      render: (m) =>
        m.status === 'INVITED' ? (
          <div className="flex flex-col items-start gap-1">
            <span className="whitespace-nowrap">
              <BrandStatusPill status="caution">Invitation pending</BrandStatusPill>
            </span>
            <span className="text-brand-meta text-brand-ink-3">Hasn&rsquo;t joined yet</span>
            {/* Owner only at the API: re-issuing mints a fresh credential for this person. */}
            {can.ownerActions && (
              <button
                type="button"
                disabled={resend.isPending}
                onClick={() => resend.mutate(m.id)}
                className="min-h-6 rounded-sm text-brand-meta font-semibold text-brand-ink underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus disabled:opacity-50"
              >
                Get invite link
              </button>
            )}
          </div>
        ) : m.status === 'ACTIVE' ? (
          <BrandStatusPill status="positive">Active</BrandStatusPill>
        ) : (
          <BrandStatusPill status="neutral">{sentence(m.status)}</BrandStatusPill>
        ),
    },
    {
      key: 'added',
      header: 'Added',
      render: (m) => (
        <span className="whitespace-nowrap tabular-nums text-brand-ink-2">
          {m.createdAt ? dateOnly(m.createdAt) : ''}
        </span>
      ),
    },
  ];

  const members = data as MemberRow[] | undefined;
  const pending = members?.filter((m) => m.status === 'INVITED').length ?? 0;

  return (
    <div>
      <PageHeader
        title="Team"
        description="The people who run this organization with you, and what each of them can do."
      />
      {/*
        The table takes the width a desktop has (five columns need it); the invite panel keeps a
        form's width beside it, and below `xl` it moves under the table rather than squeezing
        both into a laptop.
      */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:gap-8">
        <div className="min-w-0 space-y-4">
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
                      toast.push('Copy failed. Select the link and copy it by hand.', 'error');
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

          <section aria-labelledby="team-members" className="min-w-0">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="team-members" className="text-brand-body font-semibold text-brand-ink">
                Members
                {members && (
                  <span className="ml-2 tabular-nums text-brand-ink-3">{members.length}</span>
                )}
              </h2>
              {pending > 0 && (
                <p className="text-brand-meta text-brand-ink-2">
                  {pending} {pending === 1 ? 'invitation' : 'invitations'} not accepted yet
                </p>
              )}
            </div>
            <DataTable
              columns={columns}
              rows={members}
              loading={isLoading}
              rowKey={(m) => m.id}
              mobile="cards"
              caption="Team members and whether they have joined"
              error={
                teamListRefused
                  ? 'Only owners and managers can see the team list.'
                  : isError
                    ? "We couldn't load this. Please try again."
                    : undefined
              }
              onRetry={teamListRefused ? undefined : () => refetch()}
            />
          </section>
        </div>

        <Card title="Invite someone">
          <div className="space-y-4">
            {!can.ownerActions && (
              /*
                Disabled with the reason rather than removed. The API lets only the owner change
                the team, and a manager who came here to add somebody needs to know who can.
              */
              <p className="text-caption text-text-muted">
                Only the organization&rsquo;s owner can add people to the team.
              </p>
            )}
            <Input
              id="email"
              label="Email"
              type="email"
              value={email}
              disabled={!can.ownerActions}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Select
              id="role"
              label="Role"
              value={role}
              disabled={!can.ownerActions}
              onChange={(e) => setRole(e.target.value)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleName(r)}
                </option>
              ))}
            </Select>
            {/*
              What each role can do, all three at once: the permission is the decision being
              made, and comparing them is how somebody picks. The chosen one is marked by a
              surface, a hairline and the word "Selected", never by colour alone.
            */}
            <div>
              <p className="mb-1 text-brand-meta font-semibold text-brand-ink-2">
                What each role can do
              </p>
              <dl className="space-y-1">
                {ROLES.map((r) => {
                  const on = r === role;
                  return (
                    <div
                      key={r}
                      className={`rounded-brand-control border px-3 py-2 ${
                        on ? 'border-brand-line-strong bg-brand-sunken' : 'border-transparent'
                      }`}
                    >
                      <dt className="flex items-center justify-between gap-2 text-brand-ui font-semibold text-brand-ink">
                        {roleName(r)}
                        {on && (
                          <span className="text-brand-meta font-normal text-brand-ink-2">
                            Selected
                          </span>
                        )}
                      </dt>
                      <dd className="text-brand-meta text-brand-ink-2">{ROLE_HELP[r]}</dd>
                    </div>
                  );
                })}
              </dl>
            </div>
            <Button
              className="w-full"
              loading={invite.isPending}
              disabled={!email || !can.ownerActions}
              onClick={() => invite.mutate()}
            >
              Create invitation
            </Button>
            <p className="text-caption text-text-muted">
              They do not need an account first. The link creates one.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
