'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  Textarea,
  PageHeader,
  useToast,
  errorMessage,
  type MovieBody,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

const CERTIFICATES = ['U', 'U/A', 'A', 'S'];
const LANGUAGES = ['Hindi', 'English', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Bengali'];

const splitList = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export default function NewMoviePage() {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const toast = useToast();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [form, setForm] = useState({
    title: '',
    synopsis: '',
    runtimeMinutes: '',
    certificate: '',
    language: 'Hindi',
    genres: '',
    releaseDate: '',
    posterUrl: '',
    trailerUrl: '',
    cast: '',
    director: '',
  });

  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (form.title.trim().length < 2) e.title = 'Title must be at least 2 characters.';
    if (!form.language.trim()) e.language = 'Language is required.';
    const runtime = Number(form.runtimeMinutes);
    if (!form.runtimeMinutes || !Number.isFinite(runtime) || runtime < 1)
      e.runtimeMinutes = 'Runtime must be at least 1 minute.';
    if (splitList(form.genres).length === 0) e.genres = 'Add at least one genre.';
    return e;
  };

  const create = useMutation({
    mutationFn: () => {
      const body: MovieBody = {
        title: form.title.trim(),
        synopsis: form.synopsis.trim() || undefined,
        runtimeMinutes: Number(form.runtimeMinutes),
        certificate: form.certificate || undefined,
        language: form.language.trim(),
        genres: splitList(form.genres),
        releaseDate: form.releaseDate || undefined,
        posterUrl: form.posterUrl.trim() || undefined,
        trailerUrl: form.trailerUrl.trim() || undefined,
        cast: splitList(form.cast),
        director: form.director.trim() || undefined,
      };
      return api.movies.create({ organizationId: activeOrg.id, ...body });
    },
    onSuccess: (movie) => {
      toast.push('Movie created.', 'success');
      router.push(`/organizer/movies/${movie.id}`);
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
        title="New movie"
        breadcrumbs={[{ label: 'Movies', href: '/organizer/movies' }, { label: 'New' }]}
      />
      <Card>
        <div className="space-y-4">
          <Input
            id="title"
            label="Title"
            autoFocus
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            error={fieldErrors.title}
          />
          <Textarea
            id="synopsis"
            label="Synopsis"
            rows={4}
            value={form.synopsis}
            onChange={(e) => set('synopsis', e.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="runtime"
              label="Runtime (minutes)"
              type="number"
              min={1}
              value={form.runtimeMinutes}
              onChange={(e) => set('runtimeMinutes', e.target.value)}
              error={fieldErrors.runtimeMinutes}
            />
            <Input
              id="releaseDate"
              label="Release date"
              type="date"
              value={form.releaseDate}
              onChange={(e) => set('releaseDate', e.target.value)}
            />
            <Select
              id="language"
              label="Language"
              value={form.language}
              onChange={(e) => set('language', e.target.value)}
              error={fieldErrors.language}
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
            <Select
              id="certificate"
              label="Certificate"
              value={form.certificate}
              onChange={(e) => set('certificate', e.target.value)}
            >
              <option value="">Not set</option>
              {CERTIFICATES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
          <Input
            id="genres"
            label="Genres"
            hint="Comma-separated, e.g. Action, Thriller"
            value={form.genres}
            onChange={(e) => set('genres', e.target.value)}
            error={fieldErrors.genres}
          />
          <Input
            id="cast"
            label="Cast"
            hint="Comma-separated, e.g. Actor One, Actor Two"
            value={form.cast}
            onChange={(e) => set('cast', e.target.value)}
          />
          <Input
            id="director"
            label="Director"
            value={form.director}
            onChange={(e) => set('director', e.target.value)}
          />
          <Input
            id="posterUrl"
            label="Poster URL"
            value={form.posterUrl}
            onChange={(e) => set('posterUrl', e.target.value)}
          />
          <Input
            id="trailerUrl"
            label="Trailer URL"
            value={form.trailerUrl}
            onChange={(e) => set('trailerUrl', e.target.value)}
          />
          <Button loading={create.isPending} onClick={submit}>
            Create movie
          </Button>
        </div>
      </Card>
    </div>
  );
}
