'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  Accessibility,
  Armchair,
  EyeOff,
  HandHeart,
  Lock,
  Plus,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  api,
  Badge,
  Button,
  ButtonLink,
  Card,
  Dialog,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  TabPanel,
  Tabs,
  VenueMap,
  errorMessage,
  money,
  useToast,
  type VenueSectionSummary,
} from '@eticketsgo/web-kit';
import {
  SEAT_KIND_LABEL,
  countLayoutDocument,
  countLayoutRows,
  usedCategoryKeys,
  type LayoutDocument,
  type LayoutSeatKind,
} from '@eticketsgo/shared-types';
import { SeatGrid } from '@/components/layout-editor/seat-grid';
import {
  addCategory,
  addSeatsToRow,
  documentProblems,
  mergeProblem,
  mergeWithNext,
  parseRef,
  removeCategory,
  removeCategoryProblem,
  removeSection,
  renameSection,
  seatName,
  seatsInRow,
  sectionHasMixedCategories,
  setBlockSize,
  setKinds,
  setSectionCategory,
  splitSection,
  updateCategory,
} from '@/lib/layout-editor';
import { venueCurrency } from '../../../../../venue-spaces';

/**
 * Edit a draft seat layout: the seat map, and a side panel for what is selected.
 *
 * -- WHY THIS PAGE EXISTS -----------------------------------------------------------------
 * A draft could be previewed, published, cloned or rebuilt from another template - and never
 * changed. The owner built a 100-seat arena, got 110 seats and a $84.98 price he never typed,
 * and had no way to remove a seat, divide a section, price a category or mark a wheelchair
 * space. This is the place to do all of it, on the draft, before anything is sold.
 *
 * -- HOW IT IS LAID OUT ---------------------------------------------------------------------
 * One editing surface, not a scroll of forms: the room on the left (a venue map to pick a
 * block, then that block's seats), and on the right a panel with three tabs - the seats
 * selected, the section or block they are in, and the ticket categories with their prices.
 * Every change is local until "Save draft"; the totals above the map change as you work, and
 * Undo steps back through the changes since the page opened or last saved.
 *
 * -- WHAT CANNOT BE BROKEN FROM HERE --------------------------------------------------------
 * Only a DRAFT is saved; the API refuses anything else. A published layout opens read-only,
 * with "Clone to change it", because sold seats point at it.
 */

type PanelTab = 'selection' | 'section' | 'categories';

const KIND_ACTIONS: { kind: LayoutSeatKind; label: string; icon: typeof Accessibility }[] = [
  { kind: 'SEAT', label: 'Ordinary seat', icon: Armchair },
  { kind: 'WHEELCHAIR', label: 'Wheelchair space', icon: Accessibility },
  { kind: 'COMPANION', label: 'Companion seat', icon: HandHeart },
  { kind: 'RESTRICTED_VIEW', label: 'Restricted view', icon: EyeOff },
  { kind: 'HOUSE', label: 'House seat', icon: Lock },
];

const toText = (minor: number) => (minor / 100).toFixed(2).replace(/\.00$/, '');

export default function LayoutEditorPage() {
  const { screenId, layoutId } = useParams<{ screenId: string; layoutId: string }>();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const spaceHref = `/organizer/spaces/${screenId}`;
  const previewHref = `${spaceHref}/layouts/${layoutId}/preview`;

  const editorQ = useQuery({
    queryKey: ['layout-editor', layoutId],
    queryFn: () => api.theaterOps.layoutDocument(layoutId),
    // A draft being edited must not be replaced under the person by a background refetch.
    refetchOnWindowFocus: false,
  });
  const spaceQ = useQuery({
    queryKey: ['space', screenId],
    queryFn: () => api.venues.space(screenId),
  });

  const loaded = editorQ.data;
  const editable = !!loaded?.editable;
  const currency = venueCurrency(loaded?.country);
  const currencyCode = currency?.code ?? 'INR';
  const fmt = (minor: number) => money(minor, currencyCode);

  const [doc, setDoc] = useState<LayoutDocument | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [history, setHistory] = useState<LayoutDocument[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const [tab, setTab] = useState<PanelTab>('selection');
  const [problems, setProblems] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [addCount, setAddCount] = useState('1');
  const [size, setSize] = useState<{ rows: string; front: string }>({ rows: '', front: '' });
  const [splitAt, setSplitAt] = useState('');

  // Load (and reload after a save) from the server's copy.
  useEffect(() => {
    if (!loaded) return;
    setDoc(loaded.document);
    setSavedJson(JSON.stringify(loaded.document));
    setHistory([]);
    setPrices(
      Object.fromEntries(loaded.document.categories.map((c) => [c.key, toText(c.priceMinor)])),
    );
    setSelected(new Set());
  }, [loaded]);

  const dirty = !!doc && JSON.stringify(doc) !== savedJson;

  // Leaving with unsaved changes asks first, as any editor should.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const change = (next: LayoutDocument) => {
    if (!doc || next === doc) return;
    setHistory((h) => [...h.slice(-49), doc]);
    setDoc(next);
    setProblems([]);
  };
  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    setDoc(previous);
    setSelected(new Set());
    setPrices((p) => ({
      ...Object.fromEntries(previous.categories.map((c) => [c.key, toText(c.priceMinor)])),
      ...Object.fromEntries(
        Object.entries(p).filter(([k]) => !previous.categories.some((c) => c.key === k)),
      ),
    }));
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!doc) throw new Error('Nothing to save.');
      const found = documentProblems(doc, prices);
      if (found.length > 0) {
        setProblems(found);
        throw new Error(found[0]);
      }
      return api.theaterOps.saveLayoutDocument(layoutId, doc);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['layout-editor', layoutId] });
      void qc.invalidateQueries({ queryKey: ['screen', screenId, 'layouts'] });
      void qc.invalidateQueries({ queryKey: ['layout-preview', layoutId] });
      toast.push('Draft saved.', 'success');
    },
    onError: (e) => setProblems((p) => (p.length > 0 ? p : [errorMessage(e)])),
  });

  const publish = useMutation({
    mutationFn: async () => {
      if (dirty) await save.mutateAsync();
      return api.theaterOps.publishLayout(layoutId);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['screen', screenId, 'layouts'] });
      toast.push('Layout published. Sessions can use it now.', 'success');
      router.push(spaceHref);
    },
    onError: (e) => setProblems([errorMessage(e)]),
  });

  const cloneIt = useMutation({
    mutationFn: () => api.theaterOps.cloneLayout(layoutId),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['screen', screenId, 'layouts'] });
      router.push(`${spaceHref}/layouts/${created.id}/edit`);
    },
    onError: (e) => setProblems([errorMessage(e)]),
  });

  const goPreview = async () => {
    if (dirty) {
      try {
        await save.mutateAsync();
      } catch {
        return;
      }
    }
    router.push(previewHref);
  };

  const sectioned = loaded?.layoutKind === 'SECTIONED';
  const counts = useMemo(() => (doc ? countLayoutDocument(doc) : null), [doc]);
  const refs = useMemo(() => [...selected].map(parseRef), [selected]);
  const used = useMemo(() => (doc ? usedCategoryKeys(doc) : new Set<string>()), [doc]);

  // The section the panel works on: the one the selection is in, else the chosen block.
  const selectionSections = new Set(refs.map((r) => r.s));
  const current = selectionSections.size === 1 ? [...selectionSections][0] : active;
  const section = doc?.sections[current];

  // Keep the size boxes in step with the section being looked at.
  useEffect(() => {
    if (!section) return;
    setSize({ rows: String(section.rows.length), front: String(seatsInRow(section.rows[0])) });
    setSplitAt('');
    // Recomputed when the section or its shape changes, not on every keystroke elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, section?.rows.length, section && seatsInRow(section.rows[0])]);

  if (editorQ.isError) {
    return (
      <ErrorState message={errorMessage(editorQ.error)} onRetry={() => void editorQ.refetch()} />
    );
  }
  if (!loaded || !doc || !counts) return <Skeleton className="h-96 w-full" />;

  const spaceName = spaceQ.data?.name ?? 'Space';
  const sectionsShown = sectioned
    ? [Math.min(active, doc.sections.length - 1)]
    : doc.sections.map((_s, i) => i);
  const rowsSelected = [...new Set(refs.map((r) => `${r.s}:${r.r}`))].map((k) => {
    const [s, r] = k.split(':').map(Number);
    return { s, r };
  });
  const suggestedUsed = doc.categories.filter((c) => c.priceSuggested && used.has(c.key));
  const categoryName = (key: string) => doc.categories.find((c) => c.key === key)?.name ?? '';
  const seatsUsing = (key: string) =>
    doc.sections.reduce(
      (n, s) =>
        n +
        (s.categoryKey === key
          ? countLayoutRows(s.rows.filter((r) => !r.categoryKey && !r.categoryKeys)).seats
          : 0) +
        countLayoutRows(s.rows.filter((r) => r.categoryKey === key)).seats,
      0,
    );

  const blocksUsing = (key: string) =>
    doc.sections.filter(
      (s) =>
        (s.categoryKey === key && s.rows.some((r) => !r.categoryKey && !r.categoryKeys)) ||
        s.rows.some((r) => r.categoryKey === key || r.categoryKeys?.includes(key)),
    ).length;

  const venueSections: VenueSectionSummary[] = sectioned
    ? doc.sections.map((s, i) => {
        const n = countLayoutRows(s.rows).bookable;
        const price = doc.categories.find((c) => c.key === s.categoryKey)?.priceMinor ?? null;
        return {
          id: String(i),
          kind: 'SECTION',
          name: s.name,
          shape: s.shape,
          labelX: s.labelX,
          labelY: s.labelY,
          tier: s.tier,
          rotationDeg: s.rotationDeg,
          // Every block stays choosable here, even one with no seats left in it.
          availableCount: Math.max(1, n),
          totalCount: Math.max(1, n),
          priceMinorFrom: price,
          priceMinorTo: price,
        };
      })
    : [];

  const pickBlock = (index: number) => {
    setActive(index);
    setSelected(new Set());
    setTab('section');
  };

  const setPrice = (key: string, text: string) => {
    setPrices((p) => ({ ...p, [key]: text }));
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n) && n >= 0) {
      // Typing a price makes it the organizer's own, no longer a suggestion.
      change(updateCategory(doc, key, { priceMinor: Math.round(n * 100), priceSuggested: false }));
    }
  };

  const newCategoryFor = (s: number) => {
    const { doc: withNew, key } = addCategory(doc);
    setPrices((p) => ({ ...p, [key]: '' }));
    change(setSectionCategory(withNew, s, key));
  };

  const totals: { label: string; value: number; testid: string }[] = [
    { label: 'Bookable seats', value: counts.bookable, testid: 'bookable' },
    { label: 'Accessible places', value: counts.accessible, testid: 'accessible' },
    { label: 'Restricted view', value: counts.restricted, testid: 'restricted' },
    { label: 'House seats', value: counts.house, testid: 'house' },
    { label: 'Gaps and aisles', value: counts.aisles, testid: 'aisles' },
  ];

  return (
    <div className={`space-y-4 ${editable && selected.size > 0 ? 'pb-20 lg:pb-0' : ''}`}>
      <PageHeader
        title={editable ? 'Edit seat layout' : 'Seat layout'}
        description={`${doc.name}, version ${loaded.version} - ${editable ? 'Draft' : loaded.status === 'PUBLISHED' ? 'Published (frozen)' : 'Archived'}`}
        breadcrumbs={[
          { label: 'Venues & seating', href: '/organizer/venues' },
          { label: spaceName, href: spaceHref },
          { label: editable ? 'Edit layout' : 'Layout' },
        ]}
        action={
          editable ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                icon={Undo2}
                disabled={history.length === 0}
                onClick={undo}
                aria-label="Undo the last change"
              >
                Undo
              </Button>
              <Button variant="outline" onClick={() => void goPreview()} disabled={save.isPending}>
                Preview as buyer
              </Button>
              <Button variant="outline" onClick={() => setPublishing(true)}>
                Publish
              </Button>
              <Button
                loading={save.isPending}
                onClick={() => save.mutate()}
                data-testid="save-draft"
              >
                Save draft
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <ButtonLink variant="outline" href={previewHref}>
                Preview as buyer
              </ButtonLink>
              <Button loading={cloneIt.isPending} onClick={() => cloneIt.mutate()}>
                Clone to change it
              </Button>
            </div>
          )
        }
      />

      {!editable ? (
        <p
          role="note"
          className="rounded-md border border-border bg-background-subtle px-3 py-2.5 text-sm text-text-primary"
        >
          This layout is published, so it is frozen: sold seats point at it. Clone it to get a draft
          with everything kept, change the draft, then publish it.
        </p>
      ) : null}

      {/* The live totals: what the room sells, as it is being shaped. */}
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md border border-border bg-background-surface px-3 py-2 text-sm"
        data-testid="editor-totals"
        aria-live="polite"
      >
        {totals.map((t) => (
          <span key={t.testid} className="whitespace-nowrap text-text-secondary">
            {t.label}{' '}
            <strong className="tabular-nums text-text-primary" data-testid={`total-${t.testid}`}>
              {t.value.toLocaleString()}
            </strong>
          </span>
        ))}
        {editable ? (
          <span
            className={`ml-auto text-caption font-medium ${dirty ? 'text-status-warning' : 'text-text-muted'}`}
            data-testid="save-state"
          >
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
        ) : null}
      </div>

      {problems.length > 0 ? (
        <div role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
          <ul className="list-disc space-y-0.5 pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] [&>*]:min-w-0">
        <div className="space-y-4">
          {sectioned ? (
            <Card title="Blocks" padding="sm">
              <div className="mb-3 max-w-xs">
                {/* The same choice as the map, for a keyboard, a phone, or a block too small to tap. */}
                <Select
                  id="block-pick"
                  label="Block"
                  value={String(Math.min(active, doc.sections.length - 1))}
                  onChange={(e) => pickBlock(Number(e.target.value))}
                >
                  {doc.sections.map((s, i) => (
                    <option key={i} value={i}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              {/* Small enough that the chosen block's seats sit just below it, not a page away. */}
              <div className="mx-auto max-w-md">
                <VenueMap
                  focal={loaded.focal}
                  sections={venueSections}
                  onSelect={(id) => pickBlock(Number(id))}
                  formatPrice={fmt}
                  activeSectionId={String(Math.min(active, doc.sections.length - 1))}
                  availabilityLegend={false}
                  listWhenNarrow={false}
                />
              </div>
            </Card>
          ) : null}
          <Card
            title={
              sectioned
                ? `Seats in ${doc.sections[sectionsShown[0]]?.name ?? 'the block'}`
                : 'Seats'
            }
            padding="sm"
          >
            <p className="mb-3 text-caption text-text-secondary">
              {editable
                ? 'Click a seat to select it. Shift-click selects a range, dragging selects an area, a row letter selects the row. Arrow keys move; Shift and an arrow adds the next seat.'
                : 'A published layout cannot be changed here.'}
            </p>
            {/* The room scrolls inside its card, never the page. */}
            <div className="max-h-[70vh] overflow-auto pb-2">
              <SeatGrid
                doc={doc}
                sections={sectionsShown}
                selected={selected}
                readOnly={!editable}
                focalLabel={sectioned ? null : loaded.focal.label}
                onChange={(next) => {
                  setSelected(next);
                  if (next.size > 0) setTab('selection');
                }}
              />
            </div>
            <Legend doc={doc} fmt={fmt} />
          </Card>
        </div>

        <div id="editor-panel-card" className="scroll-mt-4 lg:sticky lg:top-4 lg:self-start">
          <Card padding="sm">
            {editable ? (
              <div className="mb-3">
                <Input
                  id="layout-name"
                  label="Layout name"
                  hint="Shown to you, not to buyers."
                  value={doc.name}
                  onChange={(e) => change({ ...doc, name: e.target.value })}
                />
              </div>
            ) : null}
            <Tabs<PanelTab>
              id="editor-panel"
              label="What to change"
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'selection', label: 'Selected', count: selected.size },
                { value: 'section', label: sectioned ? 'Block' : 'Section' },
                { value: 'categories', label: 'Prices', count: doc.categories.length },
              ]}
            />

            <TabPanel tabsId="editor-panel" value="selection" selected={tab} className="space-y-4">
              {refs.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  Nothing selected. Select seats on the map to remove them, put them back, or mark
                  them as wheelchair spaces, companion seats, restricted view or house seats.
                </p>
              ) : (
                <>
                  <div>
                    <p
                      className="text-sm font-medium text-text-primary"
                      data-testid="selection-summary"
                    >
                      {refs.length} selected
                    </p>
                    <p className="break-words text-caption text-text-secondary">
                      {refs
                        .slice(0, 12)
                        .map((r) => seatName(doc, r))
                        .join(', ')}
                      {refs.length > 12 ? ` and ${refs.length - 12} more` : ''}
                    </p>
                  </div>
                  {editable ? (
                    <>
                      <div
                        className="grid grid-cols-1 gap-1.5"
                        role="group"
                        aria-label="Make the selection"
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          icon={X}
                          className="justify-start"
                          onClick={() => change(setKinds(doc, refs, 'GAP'))}
                        >
                          Remove (leave a gap)
                        </Button>
                        {KIND_ACTIONS.map((a) => (
                          <Button
                            key={a.kind}
                            variant="outline"
                            size="sm"
                            icon={a.icon}
                            className="justify-start"
                            onClick={() => change(setKinds(doc, refs, a.kind))}
                          >
                            {a.label}
                          </Button>
                        ))}
                      </div>
                      <p className="text-caption text-text-muted">
                        Remove leaves a gap that keeps the seat numbers beside it; Ordinary seat
                        puts a removed seat back. A house seat is held back at every session;
                        release it for one session from that session&apos;s seat map.
                      </p>
                      <div className="space-y-2 border-t border-border pt-3">
                        <p className="text-sm font-medium text-text-primary">
                          Add seats to the end of{' '}
                          {rowsSelected.length === 1
                            ? `row ${doc.sections[rowsSelected[0].s].rows[rowsSelected[0].r].label}`
                            : `${rowsSelected.length} rows`}
                        </p>
                        <div className="flex items-end gap-2">
                          <Input
                            id="add-seats"
                            label="How many"
                            type="number"
                            min={1}
                            max={50}
                            value={addCount}
                            onChange={(e) => setAddCount(e.target.value)}
                          />
                          <Button
                            variant="secondary"
                            icon={Plus}
                            onClick={() => {
                              let next = doc;
                              for (const row of rowsSelected)
                                next = addSeatsToRow(next, row.s, row.r, Number(addCount) || 0);
                              change(next);
                            }}
                          >
                            Add
                          </Button>
                        </div>
                      </div>
                    </>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                    Clear selection
                  </Button>
                </>
              )}
            </TabPanel>

            <TabPanel tabsId="editor-panel" value="section" selected={tab} className="space-y-4">
              {!section ? null : (
                <>
                  {!sectioned && doc.sections.length > 1 ? (
                    <Select
                      id="section-pick"
                      label="Section"
                      value={String(current)}
                      onChange={(e) => {
                        setActive(Number(e.target.value));
                        setSelected(new Set());
                      }}
                    >
                      {doc.sections.map((s, i) => (
                        <option key={i} value={i}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                  <Input
                    id="section-name"
                    label={sectioned ? 'Block name' : 'Section name'}
                    value={section.name}
                    disabled={!editable}
                    onChange={(e) => change(renameSection(doc, current, e.target.value))}
                  />
                  <div className="space-y-2">
                    <Select
                      id="section-category"
                      label="Ticket category"
                      value={section.categoryKey}
                      disabled={!editable}
                      hint={
                        sectionHasMixedCategories(section)
                          ? 'Some rows here have their own category. Choosing one here applies it to every row.'
                          : undefined
                      }
                      onChange={(e) => change(setSectionCategory(doc, current, e.target.value))}
                    >
                      {doc.categories.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.name} ({fmt(c.priceMinor)}
                          {c.priceSuggested ? ', suggested' : ''})
                        </option>
                      ))}
                    </Select>
                    {editable ? (
                      <>
                        <PriceInput
                          id="section-price"
                          label={`Price of ${categoryName(section.categoryKey)} (${currency?.symbol ?? currencyCode})`}
                          value={prices[section.categoryKey] ?? ''}
                          suggested={
                            !!doc.categories.find((c) => c.key === section.categoryKey)
                              ?.priceSuggested
                          }
                          onChange={(v) => setPrice(section.categoryKey, v)}
                          onAccept={() =>
                            change(
                              updateCategory(doc, section.categoryKey, { priceSuggested: false }),
                            )
                          }
                          hint={(() => {
                            const others = doc.sections.filter(
                              (s, i) => i !== current && s.categoryKey === section.categoryKey,
                            ).length;
                            return others > 0
                              ? `The same price for ${others} other ${sectioned ? 'block' : 'section'}${others === 1 ? '' : 's'} in this category.`
                              : undefined;
                          })()}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Plus}
                          onClick={() => newCategoryFor(current)}
                        >
                          New category for this {sectioned ? 'block' : 'section'}
                        </Button>
                      </>
                    ) : null}
                  </div>

                  {editable ? (
                    <div className="space-y-2 border-t border-border pt-3">
                      <p className="text-sm font-medium text-text-primary">Size</p>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          id="block-rows"
                          label="Rows"
                          type="number"
                          min={1}
                          max={120}
                          value={size.rows}
                          onChange={(e) => setSize((v) => ({ ...v, rows: e.target.value }))}
                        />
                        <Input
                          id="block-front"
                          label="Seats in the front row"
                          type="number"
                          min={1}
                          max={200}
                          value={size.front}
                          onChange={(e) => setSize((v) => ({ ...v, front: e.target.value }))}
                        />
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          change(
                            setBlockSize(
                              doc,
                              current,
                              Number(size.rows) || 1,
                              Number(size.front) || 1,
                            ),
                          )
                        }
                      >
                        Apply size
                      </Button>
                      <p className="text-caption text-text-muted">
                        Rows are added or removed at the back. A change to the front row changes
                        every row by the same number of seats.
                      </p>
                    </div>
                  ) : null}

                  {editable && !sectioned ? (
                    <div className="space-y-2 border-t border-border pt-3">
                      <p className="text-sm font-medium text-text-primary">Divide or join</p>
                      <div className="flex items-end gap-2">
                        <Select
                          id="split-at"
                          label="Start a new section at row"
                          value={splitAt}
                          onChange={(e) => setSplitAt(e.target.value)}
                        >
                          <option value="">Choose a row</option>
                          {section.rows.slice(1).map((r, i) => (
                            <option key={r.label} value={i + 1}>
                              {r.label}
                            </option>
                          ))}
                        </Select>
                        <Button
                          variant="secondary"
                          disabled={!splitAt}
                          onClick={() => {
                            change(splitSection(doc, current, Number(splitAt)));
                            setActive(current + 1);
                            setSelected(new Set());
                          }}
                        >
                          Split
                        </Button>
                      </div>
                      {doc.sections[current + 1] ? (
                        <div>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!!mergeProblem(doc, current, sectioned)}
                            onClick={() => {
                              change(mergeWithNext(doc, current, sectioned));
                              setSelected(new Set());
                            }}
                          >
                            Join with {doc.sections[current + 1].name}
                          </Button>
                          {mergeProblem(doc, current, sectioned) ? (
                            <p className="mt-1 text-caption text-text-muted">
                              {mergeProblem(doc, current, sectioned)}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {editable && doc.sections.length > 1 ? (
                    <div className="border-t border-border pt-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        className="text-status-error"
                        onClick={() => {
                          const name = section.name;
                          change(removeSection(doc, current));
                          setActive(Math.max(0, current - 1));
                          setSelected(new Set());
                          toast.push(`Removed ${name}. Undo puts it back.`, 'success');
                        }}
                      >
                        Remove this {sectioned ? 'block' : 'section'}
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </TabPanel>

            <TabPanel tabsId="editor-panel" value="categories" selected={tab} className="space-y-3">
              <p className="text-caption text-text-secondary">
                A ticket category is a price. Prices are in {currencyCode}, the currency of the
                venue&apos;s country.
              </p>
              <ul className="space-y-3" data-testid="category-list">
                {doc.categories.map((c) => {
                  const problem = removeCategoryProblem(doc, c.key);
                  const seats = seatsUsing(c.key);
                  return (
                    <li
                      key={c.key}
                      className="space-y-2 rounded-md border border-border p-2.5"
                      data-testid={`category-${c.name}`}
                    >
                      <div className="flex items-end gap-2">
                        <label className="flex shrink-0 flex-col gap-1 text-caption text-text-secondary">
                          Colour
                          <input
                            type="color"
                            aria-label={`Colour of ${c.name}`}
                            disabled={!editable}
                            value={c.colorHex ?? '#64748B'}
                            onChange={(e) =>
                              change(
                                updateCategory(doc, c.key, {
                                  colorHex: e.target.value.toUpperCase(),
                                }),
                              )
                            }
                            className="h-11 w-11 cursor-pointer rounded-md border border-border-input bg-background-surface p-1"
                          />
                        </label>
                        <div className="min-w-0 flex-1">
                          <Input
                            id={`cat-name-${c.key}`}
                            label="Name"
                            value={c.name}
                            disabled={!editable}
                            onChange={(e) =>
                              change(updateCategory(doc, c.key, { name: e.target.value }))
                            }
                          />
                        </div>
                      </div>
                      <PriceInput
                        id={`cat-price-${c.key}`}
                        label={`Price (${currency?.symbol ?? currencyCode})`}
                        value={prices[c.key] ?? ''}
                        disabled={!editable}
                        suggested={c.priceSuggested}
                        onChange={(v) => setPrice(c.key, v)}
                        onAccept={() =>
                          change(updateCategory(doc, c.key, { priceSuggested: false }))
                        }
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-caption text-text-muted">
                          {seats > 0
                            ? `In use: ${seats.toLocaleString()} seats in ${blocksUsing(c.key)} ${
                                sectioned ? 'block' : 'section'
                              }${blocksUsing(c.key) === 1 ? '' : 's'}`
                            : 'Not used by any seat yet'}
                        </span>
                        {/* Only an unused category can go: one in use would leave seats unpriced. */}
                        {editable && !problem ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Trash2}
                            onClick={() => change(removeCategory(doc, c.key))}
                          >
                            Remove<span className="sr-only"> {c.name}</span>
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {editable ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Plus}
                  onClick={() => {
                    const { doc: next, key } = addCategory(doc);
                    setPrices((p) => ({ ...p, [key]: '' }));
                    change(next);
                  }}
                >
                  Add a category
                </Button>
              ) : null}
            </TabPanel>
          </Card>
        </div>
      </div>

      {/*
        On a phone the panel sits below the room, so a tapped seat's actions were a long scroll
        away. A bar at the bottom says what is selected and jumps to them.
      */}
      {editable && selected.size > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-border bg-background-surface px-4 py-3 shadow-lg lg:hidden">
          <span className="text-sm font-medium text-text-primary">{selected.size} selected</span>
          <span className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setTab('selection');
                document
                  .getElementById('editor-panel-card')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              Change them
            </Button>
          </span>
        </div>
      ) : null}

      {publishing ? (
        <Dialog
          open
          onClose={() => setPublishing(false)}
          title={`Publish ${doc.name}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setPublishing(false)}>
                Cancel
              </Button>
              <Button loading={publish.isPending} onClick={() => publish.mutate()}>
                {suggestedUsed.length > 0 ? 'Confirm prices and publish' : 'Publish'}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>
              Publishing freezes this layout: sessions can then use it, and to change it you clone
              it. {dirty ? 'Your unsaved changes are saved first.' : ''}
            </p>
            <p>
              Buyers can book <strong className="tabular-nums">{counts.bookable}</strong> seats
              {counts.accessible > 0 ? `, ${counts.accessible} of them accessible places` : ''}
              {counts.house > 0
                ? `. ${counts.house} house seats are held back at every session`
                : ''}
              .
            </p>
            <ul className="space-y-1 rounded-md border border-border p-2.5">
              {doc.categories
                .filter((c) => used.has(c.key))
                .map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-2">
                    <span>{c.name}</span>
                    <span className="tabular-nums">
                      {fmt(c.priceMinor)}
                      {c.priceSuggested ? <Badge tone="warning">Suggested</Badge> : null}
                    </span>
                  </li>
                ))}
            </ul>
            {suggestedUsed.length > 0 ? (
              <p role="note" className="rounded-md bg-status-warning/10 p-3">
                {suggestedUsed.map((c) => c.name).join(', ')}{' '}
                {suggestedUsed.length === 1 ? 'has a price' : 'have prices'} the template worked
                out, not one you typed. Publishing confirms{' '}
                {suggestedUsed.length === 1 ? 'it' : 'them'}. To change{' '}
                {suggestedUsed.length === 1 ? 'it' : 'them'}, cancel and use Prices.
              </p>
            ) : null}
            {problems.length > 0 ? (
              <p role="alert" className="rounded-md bg-status-error/10 p-3">
                {problems[0]}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/** A price box that says when its price is only a template's suggestion, and can accept it. */
function PriceInput({
  id,
  label,
  value,
  suggested,
  disabled,
  hint,
  onChange,
  onAccept,
}: {
  id: string;
  label: string;
  value: string;
  suggested: boolean;
  disabled?: boolean;
  hint?: string;
  onChange: (value: string) => void;
  onAccept: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <Input
        id={id}
        label={label}
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        hint={hint}
        error={value.trim() === '' && !disabled ? 'Enter a price.' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {suggested ? (
        <div
          className="flex flex-wrap items-center gap-2 text-caption"
          data-testid={`${id}-suggested`}
        >
          <Badge tone="warning">Suggested</Badge>
          <span className="text-text-secondary">Worked out by the template, not set by you.</span>
          {!disabled ? (
            <Button variant="ghost" size="sm" onClick={onAccept}>
              Keep this price
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What the colours and icons on the seats mean. */
function Legend({ doc, fmt }: { doc: LayoutDocument; fmt: (minor: number) => string }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border pt-3 text-caption text-text-secondary">
      {doc.categories.map((c) => (
        <span key={c.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-3 w-3 rounded-sm border-2"
            style={{ borderColor: c.colorHex ?? undefined }}
          />
          {c.name} {fmt(c.priceMinor)}
        </span>
      ))}
      {(
        [
          ['WHEELCHAIR', Accessibility],
          ['COMPANION', HandHeart],
          ['RESTRICTED_VIEW', EyeOff],
          ['HOUSE', Lock],
        ] as const
      ).map(([kind, Icon]) => (
        <span key={kind} className="flex items-center gap-1">
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {SEAT_KIND_LABEL[kind]}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <span aria-hidden className="h-3 w-3 rounded-sm border border-dashed border-border" />
        Removed (gap)
      </span>
    </div>
  );
}
