'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Textarea,
  Skeleton,
  ErrorState,
  PageHeader,
  StatusBadge,
  useToast,
  errorMessage,
  type OrganizationProfileInput,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

const PROFILE_FIELDS: {
  key: keyof OrganizationProfileInput;
  label: string;
  placeholder?: string;
}[] = [
  { key: 'website', label: 'Website', placeholder: 'https://example.com' },
  { key: 'contactEmail', label: 'Public contact email', placeholder: 'hello@example.com' },
  { key: 'contactPhone', label: 'Public contact phone', placeholder: '+91 98765 43210' },
  { key: 'logoUrl', label: 'Logo URL', placeholder: 'https://…/logo.png' },
  { key: 'coverImageUrl', label: 'Cover image URL', placeholder: 'https://…/cover.jpg' },
  { key: 'twitterUrl', label: 'X / Twitter', placeholder: 'https://x.com/…' },
  { key: 'instagramUrl', label: 'Instagram', placeholder: 'https://instagram.com/…' },
  { key: 'facebookUrl', label: 'Facebook', placeholder: 'https://facebook.com/…' },
];

export default function SettingsPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const {
    data: profile,
    isLoading,
    isError,
    refetch,
  } = useQuery({ queryKey: ['profile'], queryFn: () => api.users.profile() });
  const [fullName, setFullName] = useState('');

  // Public organizer profile form, seeded from the active org.
  const [form, setForm] = useState<OrganizationProfileInput>({});
  useEffect(() => {
    setForm({
      description: activeOrg.description ?? '',
      website: activeOrg.website ?? '',
      contactEmail: activeOrg.contactEmail ?? '',
      contactPhone: activeOrg.contactPhone ?? '',
      logoUrl: activeOrg.logoUrl ?? '',
      coverImageUrl: activeOrg.coverImageUrl ?? '',
      twitterUrl: activeOrg.twitterUrl ?? '',
      instagramUrl: activeOrg.instagramUrl ?? '',
      facebookUrl: activeOrg.facebookUrl ?? '',
    });
  }, [activeOrg]);
  const setField = (key: keyof OrganizationProfileInput, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const saveOrg = useMutation({
    mutationFn: () => api.organizations.updateProfile(activeOrg.id, form),
    onSuccess: () => {
      toast.push('Organizer profile updated.', 'success');
      qc.invalidateQueries({ queryKey: ['organizations', 'mine'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  useEffect(() => {
    if (profile) setFullName(profile.fullName);
  }, [profile]);

  const save = useMutation({
    mutationFn: () => api.users.updateProfile(fullName),
    onSuccess: () => {
      toast.push('Profile updated.', 'success');
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Organization">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-text-muted">Name</dt>
              <dd className="text-text-primary">{activeOrg.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Status</dt>
              <dd>
                <StatusBadge status={activeOrg.status} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Contact</dt>
              <dd className="text-text-primary">{activeOrg.contactEmail ?? '—'}</dd>
            </div>
          </dl>
        </Card>
        <Card title="Your profile">
          {isError ? (
            <ErrorState
              message="We couldn't load this. Please try again."
              onRetry={() => refetch()}
            />
          ) : isLoading || !profile ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-11 w-32" />
            </div>
          ) : (
            <div className="space-y-3">
              <Input
                id="name"
                label="Full name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
              <Input id="email" label="Email" value={profile.email ?? ''} disabled />
              <Button loading={save.isPending} onClick={() => save.mutate()}>
                Save profile
              </Button>
            </div>
          )}
        </Card>
      </div>

      <Card title="Public organizer profile">
        <p className="-mt-2 mb-4 text-caption text-text-secondary">
          Shown on your organizer page and event listings. Leave a field blank to hide it.
        </p>
        <div className="space-y-4">
          <Textarea
            id="org-description"
            label="About"
            rows={4}
            maxLength={2000}
            placeholder="Tell attendees who you are and what you host."
            value={form.description ?? ''}
            onChange={(e) => setField('description', e.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {PROFILE_FIELDS.map((f) => (
              <Input
                key={f.key}
                id={`org-${f.key}`}
                label={f.label}
                placeholder={f.placeholder}
                value={(form[f.key] as string) ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            ))}
          </div>
          <Button loading={saveOrg.isPending} onClick={() => saveOrg.mutate()}>
            Save organizer profile
          </Button>
        </div>
      </Card>
    </div>
  );
}
