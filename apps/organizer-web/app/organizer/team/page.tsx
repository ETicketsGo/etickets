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

export default function TeamPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('CHECKIN_STAFF');

  const { data, isLoading } = useQuery({
    queryKey: ['members', activeOrg.id],
    queryFn: () => api.organizations.members(activeOrg.id),
  });

  const invite = useMutation({
    mutationFn: () => api.organizations.invite(activeOrg.id, { email, role }),
    onSuccess: () => {
      toast.push('Team member invited.', 'success');
      setEmail('');
      qc.invalidateQueries({ queryKey: ['members', activeOrg.id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<OrgMember>[] = [
    { key: 'name', header: 'Name', render: (m) => m.user.fullName },
    { key: 'email', header: 'Email', render: (m) => m.user.email },
    { key: 'role', header: 'Role', render: (m) => m.role.replaceAll('_', ' ') },
    { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <PageHeader title="Team" description="People who can manage this organization." />
        <DataTable columns={columns} rows={data} loading={isLoading} rowKey={(m) => m.id} />
      </div>
      <Card title="Invite member">
        <div className="space-y-3">
          <Input
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Select id="role" label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r.replaceAll('_', ' ')}
              </option>
            ))}
          </Select>
          <Button
            className="w-full"
            loading={invite.isPending}
            disabled={!email}
            onClick={() => invite.mutate()}
          >
            Send invite
          </Button>
        </div>
      </Card>
    </div>
  );
}
