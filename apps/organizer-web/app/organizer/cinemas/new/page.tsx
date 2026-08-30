'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  PageHeader,
  useToast,
  errorMessage,
  type CinemaBody,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

export default function NewCinemaPage() {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const toast = useToast();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [form, setForm] = useState({
    name: '',
    brand: '',
    city: '',
    address: '',
    latitude: '',
    longitude: '',
  });

  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (form.name.trim().length < 2) e.name = 'Name must be at least 2 characters.';
    if (!form.city.trim()) e.city = 'City is required.';
    if (form.latitude && !Number.isFinite(Number(form.latitude)))
      e.latitude = 'Latitude must be a number.';
    if (form.longitude && !Number.isFinite(Number(form.longitude)))
      e.longitude = 'Longitude must be a number.';
    return e;
  };

  const create = useMutation({
    mutationFn: () => {
      const body: CinemaBody = {
        name: form.name.trim(),
        brand: form.brand.trim() || undefined,
        city: form.city.trim(),
        address: form.address.trim() || undefined,
        latitude: form.latitude ? Number(form.latitude) : undefined,
        longitude: form.longitude ? Number(form.longitude) : undefined,
      };
      return api.cinemas.create({ organizationId: activeOrg.id, ...body });
    },
    onSuccess: (cinema) => {
      toast.push('Cinema created.', 'success');
      router.push(`/organizer/cinemas/${cinema.id}`);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const submit = () => {
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    create.mutate();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="New location"
        breadcrumbs={[{ label: 'Rooms & seat maps', href: '/organizer/cinemas' }, { label: 'New' }]}
      />
      <Card>
        <div className="space-y-4">
          <Input
            id="name"
            label="Name"
            autoFocus
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            error={fieldErrors.name}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="brand"
              label="Brand"
              value={form.brand}
              onChange={(e) => set('brand', e.target.value)}
            />
            <Input
              id="city"
              label="City"
              value={form.city}
              onChange={(e) => set('city', e.target.value)}
              error={fieldErrors.city}
            />
          </div>
          <Input
            id="address"
            label="Address"
            value={form.address}
            onChange={(e) => set('address', e.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="latitude"
              label="Latitude"
              value={form.latitude}
              onChange={(e) => set('latitude', e.target.value)}
              error={fieldErrors.latitude}
            />
            <Input
              id="longitude"
              label="Longitude"
              value={form.longitude}
              onChange={(e) => set('longitude', e.target.value)}
              error={fieldErrors.longitude}
            />
          </div>
          <Button loading={create.isPending} onClick={submit}>
            Create location
          </Button>
        </div>
      </Card>
    </div>
  );
}
