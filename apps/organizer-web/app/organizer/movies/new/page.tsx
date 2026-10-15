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
import { PosterPicker } from '@/components/cinema/poster-picker';
import { CERTIFICATES } from '@/components/cinema/certificates';
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
  /*
    The picked poster waits here until the film exists: the upload needs the film's id. A
    picked file wins over a pasted link, which is the second way.
  */
  const [poster, setPoster] = useState<{ image: Blob; preview: string } | null>(null);

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
        posterUrl: poster ? undefined : form.posterUrl.trim() || undefined,
        trailerUrl: form.trailerUrl.trim() || undefined,
        cast: splitList(form.cast),
        director: form.director.trim() || undefined,
      };
      return api.movies.create({ organizationId: activeOrg.id, ...body });
    },
    onSuccess: async (movie) => {
      if (poster) {
        try {
          await api.movies.uploadPoster(movie.id, poster.image);
        } catch (e) {
          // The film is saved either way; say so, and where the poster can be added again.
          toast.push(
            `Movie created, but the poster did not upload: ${errorMessage(e)} Add it again from the film's Details tab.`,
            'error',
          );
          router.push(`/organizer/movies/${movie.id}?tab=details`);
          return;
        }
      }
      // It starts as a draft: say so, so "Publish" is not a surprise later.
      toast.push(
        'Movie created as a draft. Publish it when its shows are ready to sell.',
        'success',
      );
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
    <div className="max-w-3xl space-y-6">
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
          <PosterPicker
            src={poster?.preview ?? (form.posterUrl.trim() || null)}
            title={form.title}
            busy={create.isPending && !!poster}
            onPick={(image, preview) => setPoster({ image, preview })}
            linkField={
              <Input
                id="posterUrl"
                label="Poster link"
                hint="The full address of an image, starting with https://"
                value={form.posterUrl}
                onChange={(e) => {
                  set('posterUrl', e.target.value);
                  setPoster(null);
                }}
              />
            }
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
