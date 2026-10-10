'use client';

import { useState, type ReactNode } from 'react';
import {
  Banknote,
  Building2,
  CalendarDays,
  Clock,
  Copy,
  Film,
  Inbox,
  MapPin,
  Pencil,
  Plus,
  Search,
  Ticket,
  Trash2,
  Users,
} from 'lucide-react';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  ColorSchemeSwitch,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  IconButton,
  IconTile,
  ImageFrame,
  Input,
  LifecyclePill,
  Menu,
  Meter,
  PageHeader,
  ProgressMeter,
  SectionCard,
  SectionLink,
  SegmentedControl,
  Select,
  SellingPill,
  SetupPill,
  Skeleton,
  SkeletonCard,
  SkeletonText,
  StatCard,
  StatusBadge,
  StatusPill,
  TabLinks,
  TabPanel,
  Tabs,
  Textarea,
  Toggle,
  Toolbar,
  Tooltip,
  type Column,
  type Lifecycle,
  type PillTone,
  type TileTone,
} from '@eticketsgo/web-kit';

/*
  ── THE STYLE PAGE ───────────────────────────────────────────────────────────────────
  Every console primitive on one page, rendered by the real components in the real shell, so
  what a page team sees here is what their page will get. Switch Light / Dark in the top bar
  to see both themes. Every figure, name and date below is a SAMPLE, and says so: this page
  shows components, it reads no data.
*/

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="scroll-mt-24">
      <h2 id={id} className="font-display text-headline font-bold text-text-primary">
        {title}
      </h2>
      {note && <p className="mt-1 max-w-prose text-ui text-text-secondary">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Swatch({ name, className, text }: { name: string; className: string; text?: string }) {
  return (
    <div className="min-w-0">
      <div
        className={`flex h-14 items-end rounded-md border border-border p-2 text-micro font-semibold ${className}`}
      >
        {text ?? 'Aa'}
      </div>
      <p className="mt-1 truncate font-mono text-[0.6875rem] text-text-muted">{name}</p>
    </div>
  );
}

const SAMPLE_ROWS = [
  { id: '1', name: 'Sample: Stand-up night', venue: 'Sample hall, Hyderabad', sold: 45, cap: 100 },
  { id: '2', name: 'Sample: Music evening', venue: 'Sample arena, Bengaluru', sold: 12, cap: 200 },
  {
    id: '3',
    name: 'Sample: Film screening',
    venue: 'Sample screen 1, Vijayawada',
    sold: 200,
    cap: 200,
  },
];
type Row = (typeof SAMPLE_ROWS)[number];

const COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Event', render: (r) => r.name, sortable: true, sortValue: (r) => r.name },
  { key: 'venue', header: 'Venue', render: (r) => r.venue },
  {
    key: 'sold',
    header: 'Sold',
    render: (r) => (
      <span className="tabular-nums">
        {r.sold} / {r.cap}
      </span>
    ),
    sortable: true,
    sortValue: (r) => r.sold,
  },
  {
    key: 'actions',
    header: <span className="sr-only">Actions</span>,
    mobileLabel: 'Actions',
    render: (r) => (
      <Menu
        trigger="icon"
        label={`More actions for ${r.name}`}
        size="sm"
        items={[
          { label: 'Duplicate', icon: Copy, onSelect: () => undefined },
          { kind: 'separator' },
          { label: 'Delete', icon: Trash2, danger: true, onSelect: () => undefined },
        ]}
      />
    ),
  },
];

const LIFECYCLE: Lifecycle[] = [
  'draft',
  'in-review',
  'approved',
  'published',
  'ended',
  'cancelled',
];
const TONES: PillTone[] = ['success', 'warning', 'error', 'info', 'neutral', 'primary', 'marquee'];
const TILES: TileTone[] = ['teal', 'blue', 'purple', 'amber', 'rose', 'neutral'];

export function DesignSystemGallery() {
  const [tab, setTab] = useState<'overview' | 'sessions' | 'tickets'>('overview');
  const [segment, setSegment] = useState<'day' | 'week' | 'month'>('week');
  const [toggle, setToggle] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-12">
      <PageHeader
        eyebrow="Design system"
        title="Console components"
        description="Every shared primitive, as the page teams get it. All names and figures here are samples."
        meta={
          <>
            <StatusPill tone="primary">Development servers only</StatusPill>
            <ColorSchemeSwitch labels />
          </>
        }
        action={
          <Button icon={Plus} onClick={() => setModal(true)}>
            Primary action
          </Button>
        }
      />

      <Section
        id="ds-colour"
        title="Colour tokens"
        note="Surfaces, ink, the console teal, status, pastel tiles and the navy sidebar. Every text pair here is held to WCAG AA by token-contrast.test.ts."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <Swatch name="--background-canvas" className="bg-background-canvas text-text-primary" />
          <Swatch name="--background-surface" className="bg-background-surface text-text-primary" />
          <Swatch name="--background-subtle" className="bg-background-subtle text-text-primary" />
          <Swatch name="--text-secondary" className="bg-background-surface text-text-secondary" />
          <Swatch name="--text-muted" className="bg-background-surface text-text-muted" />
          <Swatch
            name="--border-input"
            className="border-2 border-border-input bg-background-surface text-text-primary"
          />
          <Swatch
            name="--action-primary"
            className="bg-action-primary text-action-primary-foreground"
          />
          <Swatch name="--tint-primary" className="bg-tint-primary text-action-primary" />
          <Swatch name="--tint-success" className="bg-tint-success text-status-success" />
          <Swatch name="--tint-warning" className="bg-tint-warning text-status-warning" />
          <Swatch name="--tint-error" className="bg-tint-error text-status-error" />
          <Swatch name="--tint-info" className="bg-tint-info text-status-info" />
          <Swatch name="--tile-teal" className="bg-tile-teal text-tile-teal-foreground" />
          <Swatch name="--tile-blue" className="bg-tile-blue text-tile-blue-foreground" />
          <Swatch name="--tile-purple" className="bg-tile-purple text-tile-purple-foreground" />
          <Swatch name="--tile-amber" className="bg-tile-amber text-tile-amber-foreground" />
          <Swatch name="--tile-rose" className="bg-tile-rose text-tile-rose-foreground" />
          <Swatch name="--marquee" className="bg-tint-marquee text-marquee" />
          <Swatch
            name="--nav-background"
            className="border-nav-border bg-nav text-nav-foreground"
          />
          <Swatch
            name="--nav-muted"
            className="border-nav-border bg-nav text-nav-muted"
            text="GROUP"
          />
          <Swatch
            name="--nav-active"
            className="border-nav-border bg-nav-active text-nav-active-foreground"
          />
          <Swatch
            name="--nav-hover"
            className="border-nav-border bg-nav-hover text-nav-foreground"
          />
        </div>
      </Section>

      <Section
        id="ds-type"
        title="Type"
        note="Plus Jakarta Sans (font-display) for titles and big numbers; Inter for everything read at length. Scale 30 / 24 / 20 / 16 / 14 / 13 / 12; tabular figures for money, counts and times."
      >
        <Card padding="md" className="space-y-3">
          <p className="font-display text-display font-bold">text-display, 30px page title</p>
          <p className="font-display text-headline font-bold">text-headline, 24px section</p>
          <p className="font-display text-title font-semibold">text-title, 20px card title</p>
          <p className="text-body">text-body, 16px - reading text for paragraphs.</p>
          <p className="text-ui">text-ui, 14px - nav items, table cells, controls.</p>
          <p className="text-caption text-text-secondary">
            text-caption, 13px - captions and hints.
          </p>
          <p className="text-micro font-semibold uppercase tracking-[0.08em] text-text-muted">
            text-micro, 12px - labels and group headings
          </p>
          <p className="font-display text-[1.625rem] font-bold tabular-nums">
            Rs 1,23,456.00 / 482
          </p>
        </Card>
      </Section>

      <Section
        id="ds-shape"
        title="Shape and elevation"
        note="Console radii: 8 (sm), 10 (md: buttons, inputs), 14 (lg: cards), 16 (xl: dialogs). Hover lifts one step; press insets; focus is a 2px teal ring with an offset."
      >
        <div className="flex flex-wrap items-end gap-4">
          {(['rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-2xl'] as const).map((r) => (
            <div
              key={r}
              className={`flex h-20 w-28 items-end border border-border bg-background-surface p-2 text-micro text-text-muted ${r}`}
            >
              {r}
            </div>
          ))}
          {(['shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg'] as const).map((s) => (
            <div
              key={s}
              className={`flex h-20 w-28 items-end rounded-lg bg-background-surface p-2 text-micro text-text-muted ${s}`}
            >
              {s}
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="ds-buttons"
        title="Buttons, icon buttons and menus"
        note="One primary per view. IconButton requires a label (its accessible name and tooltip). Both menu triggers open a real role=menu."
      >
        <Card padding="md" className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="tinted">Manage</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger" icon={Trash2}>
              Delete
            </Button>
            <Button disabled>Disabled</Button>
            <Button
              loading={busy}
              onClick={() => {
                setBusy(true);
                setTimeout(() => setBusy(false), 1500);
              }}
            >
              {busy ? 'Saving' : 'Save (shows loading)'}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg" icon={Plus}>
              Large
            </Button>
            <ButtonLink href="/organizer/design-system#ds-buttons" variant="outline" icon={Pencil}>
              Button link
            </ButtonLink>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <IconButton icon={Pencil} label="Edit sample" />
            <IconButton icon={Copy} label="Duplicate sample" variant="outline" />
            <IconButton icon={Plus} label="Add sample" variant="primary" />
            <IconButton icon={Ticket} label="Sample tickets" variant="tinted" />
            <IconButton icon={Trash2} label="Delete sample" variant="danger" />
            <IconButton icon={Inbox} label="Sample inbox, 3 unread" badge={3} />
            <Menu
              items={[
                {
                  kind: 'link',
                  label: 'Open sample page',
                  href: '/organizer/design-system#ds-menu',
                },
                { label: 'Duplicate', icon: Copy, onSelect: () => undefined },
                {
                  kind: 'note',
                  label: 'Cancel event',
                  reason: 'Not offered: sample reason in words.',
                },
                { kind: 'separator' },
                { label: 'Delete', icon: Trash2, danger: true, onSelect: () => undefined },
              ]}
            />
            <Menu
              trigger="icon"
              label="More actions for the sample event"
              items={[
                { label: 'Edit', icon: Pencil, onSelect: () => undefined },
                { label: 'Duplicate', icon: Copy, onSelect: () => undefined },
              ]}
            />
            <Tooltip content="Tooltips show on hover and keyboard focus, and Escape hides them.">
              <Button variant="ghost" size="sm">
                Hover or focus me
              </Button>
            </Tooltip>
          </div>
        </Card>
      </Section>

      <Section id="ds-forms" title="Form controls">
        <Card padding="md">
          <div className="grid max-w-form gap-4 sm:grid-cols-2">
            <Input label="Event name" placeholder="Sample event" hint="Shown to buyers." />
            <Input label="With an error" defaultValue="x" error="Use at least 3 characters." />
            <Input label="Search" icon={Search} placeholder="Find a sample" />
            <Select label="Category" defaultValue="music" hint="Pick the closest one.">
              <option value="music">Music</option>
              <option value="comedy">Comedy</option>
            </Select>
            <div className="sm:col-span-2">
              <Textarea label="Description" rows={3} placeholder="Sample text" />
            </div>
            <div className="flex items-center gap-3">
              <Toggle checked={toggle} onChange={setToggle} aria-label="Sample switch" />
              <span className="text-ui text-text-secondary">
                Sample switch is {toggle ? 'on' : 'off'}
              </span>
            </div>
            <SegmentedControl
              label="Sample view"
              value={segment}
              onChange={setSegment}
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
              ]}
            />
          </div>
        </Card>
      </Section>

      <Section
        id="ds-status"
        title="Status vocabulary"
        note="Lifecycle: Draft, In review, Approved, Published, Ended, Cancelled. Selling comes only from the server's unified eligibility; a partly eligible event never reads as bare Selling."
      >
        <Card padding="md" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {LIFECYCLE.map((l) => (
              <LifecyclePill key={l} status={l} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <SellingPill state="selling" />
            <SellingPill state="partly" reason="2 sessions closed" />
            <SellingPill state="not" reason="no ticket types" />
            <SetupPill missing={0} />
            <SetupPill missing={3} />
          </div>
          {/*
            A restriction is never cut off: a long reason wraps in the pill, and in a dense
            column the stacked layout prints the reason as text under the state word.
          */}
          <div className="grid gap-4 sm:grid-cols-2" data-testid="ds-long-reasons">
            <div className="min-w-0 space-y-2">
              <p className="text-caption font-semibold text-text-secondary">Long reason, wraps</p>
              <SellingPill
                state="partly"
                reason="Telangana pricing rules are not set for 3 of 5 shows"
                size="sm"
              />
            </div>
            <div className="w-40 min-w-0 space-y-2">
              <p className="text-caption font-semibold text-text-secondary">Dense cell, stacked</p>
              <SellingPill
                state="not"
                reason="Telangana pricing rules are not set"
                size="sm"
                layout="stacked"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {TONES.map((t) => (
              <StatusPill key={t} tone={t}>
                {t}
              </StatusPill>
            ))}
            <StatusBadge status="CONFIRMED" />
            <Badge tone="info">Badge</Badge>
          </div>
        </Card>
      </Section>

      <Section
        id="ds-cards"
        title="Cards and stat cards"
        note="Stat cards carry no trend unless an API returns a comparable prior period."
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            icon={Ticket}
            tile="teal"
            label="Tickets sold"
            value="482"
            hint="Sample figure"
          />
          <StatCard
            icon={Banknote}
            tile="blue"
            label="Gross sales"
            value="Rs 76,420"
            hint="Sample figure"
          />
          <StatCard
            icon={Users}
            tile="purple"
            label="Checked in"
            value="412"
            hint="Sample figure"
          />
          <StatCard
            icon={CalendarDays}
            tile="amber"
            label="Upcoming events"
            value="6"
            hint="Sample: 2 this week"
            href="/organizer/design-system#ds-cards"
          />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <SectionCard
            title="Section card"
            description="A titled region with one way onward."
            action={
              <SectionLink href="/organizer/design-system#ds-cards" srLabel="sample items">
                View all
              </SectionLink>
            }
          >
            <p className="text-ui text-text-secondary">Body content sits here with 20px padding.</p>
          </SectionCard>
          <Card padding="md" title="Card with a title" action={<Badge>Sample</Badge>}>
            <div className="flex flex-wrap gap-2">
              {TILES.map((t) => (
                <IconTile key={t} icon={Film} tone={t} />
              ))}
            </div>
          </Card>
        </div>
      </Section>

      <Section
        id="ds-media"
        title="Images, meters and the event card"
        note="ImageFrame keeps a fixed ratio with object-cover, lazy loads, needs alt text, and falls back to the branded placeholder when there is no image or it fails to load."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ImageFrame alt="" ratio="16:9" category="event" />
          <ImageFrame
            alt="Placeholder for a venue with no photo"
            ratio="16:9"
            category="venue"
            placeholderLabel="Sample hall, Hyderabad"
          />
          <ImageFrame
            alt="A sample image whose file is missing"
            src="/does-not-exist.jpg"
            ratio="16:9"
            category="music"
          />
          <div className="grid grid-cols-2 gap-3">
            <ImageFrame alt="" ratio="2:3" category="movie" />
            <ImageFrame alt="" ratio="1:1" category="comedy" />
          </div>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SAMPLE_ROWS.map((r, i) => (
            <article
              key={r.id}
              className="overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs"
            >
              <ImageFrame
                alt=""
                ratio="16:9"
                rounded="none"
                category={i === 2 ? 'movie' : i === 1 ? 'music' : 'comedy'}
                className="max-h-36"
                overlay={
                  <LifecyclePill
                    status={i === 0 ? 'published' : i === 1 ? 'draft' : 'ended'}
                    size="sm"
                  />
                }
              />
              <div className="p-4">
                <h3 className="truncate font-display text-[1rem] font-bold text-text-primary">
                  {r.name}
                </h3>
                <p className="mt-1.5 flex items-center gap-1.5 text-caption text-text-secondary">
                  <Clock className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden />
                  Sample: Sat, 24 Oct, 6:00 PM IST
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-caption text-text-secondary">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden />
                  <span className="truncate">{r.venue}</span>
                </p>
                <div className="mt-3">
                  <ProgressMeter value={r.sold} max={r.cap} size="sm" />
                </div>
                <div className="mt-4 flex gap-2">
                  <Button variant="tinted" size="sm" className="flex-1">
                    Manage
                  </Button>
                  <Menu
                    trigger="icon"
                    size="sm"
                    label={`More actions for ${r.name}`}
                    items={[{ label: 'Duplicate', icon: Copy, onSelect: () => undefined }]}
                  />
                </div>
              </div>
            </article>
          ))}
        </div>
        <Card padding="md" className="mt-4 grid gap-5 sm:grid-cols-2">
          <ProgressMeter value={45} max={100} />
          <ProgressMeter value={1} max={51001} tone="success" />
          <ProgressMeter value={37} max={0} unit="sold, no capacity set" />
          <div>
            <p className="mb-2 text-caption text-text-secondary">Meter (bar only)</p>
            <Meter value={3} max={4} label="Sample: 3 of 4 steps done" />
          </div>
        </Card>
      </Section>

      <Section id="ds-tabs" title="Tabs">
        <Card padding="md">
          <Tabs
            id="ds-sample-tabs"
            label="Sample event sections"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'overview', label: 'Overview' },
              { value: 'sessions', label: 'Sessions', count: 4 },
              { value: 'tickets', label: 'Tickets', count: 2 },
            ]}
          />
          <TabPanel tabsId="ds-sample-tabs" value="overview" selected={tab}>
            <p className="text-ui text-text-secondary">
              Arrow keys move between tabs; Tab moves into this panel.
            </p>
          </TabPanel>
          <TabPanel tabsId="ds-sample-tabs" value="sessions" selected={tab}>
            <p className="text-ui text-text-secondary">Sample sessions panel.</p>
          </TabPanel>
          <TabPanel tabsId="ds-sample-tabs" value="tickets" selected={tab}>
            <p className="text-ui text-text-secondary">Sample tickets panel.</p>
          </TabPanel>
          <div className="mt-6">
            <TabLinks
              label="Sample page tabs"
              current="/organizer/design-system"
              links={[
                { href: '/organizer/design-system', label: 'Components' },
                { href: '/organizer/design-system#ds-table', label: 'Tables' },
              ]}
            />
          </div>
        </Card>
      </Section>

      <Section
        id="ds-table"
        title="Table"
        note="Sticky header option, 52px rows (44px compact), and below 640px each row becomes a card."
      >
        <Toolbar
          label="Filter sample events"
          actions={
            <Button size="sm" variant="outline">
              Export
            </Button>
          }
        >
          <div className="w-full sm:w-64">
            <Input aria-label="Search sample events" icon={Search} placeholder="Search" />
          </div>
        </Toolbar>
        <DataTable
          columns={COLUMNS}
          rows={SAMPLE_ROWS}
          rowKey={(r) => r.id}
          stickyHeader
          mobile="cards"
          caption="Sample events"
        />
      </Section>

      <Section
        id="ds-overlays"
        title="Drawer and modal"
        note="Escape closes; focus moves in, stays in, and returns to the button that opened it."
      >
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => setDrawer(true)}>
            Open drawer
          </Button>
          <Button variant="outline" onClick={() => setModal(true)}>
            Open modal
          </Button>
        </div>
        <Drawer
          open={drawer}
          onClose={() => setDrawer(false)}
          title="Sample booking"
          description="A quick look without leaving the list."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDrawer(false)}>
                Close
              </Button>
              <Button variant="tinted">Open booking</Button>
            </>
          }
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-ui">
            <dt className="text-text-muted">Reference</dt>
            <dd className="font-mono">ETG-SAMPLE-0001</dd>
            <dt className="text-text-muted">Status</dt>
            <dd>
              <StatusPill tone="success">Confirmed</StatusPill>
            </dd>
          </dl>
        </Drawer>
        <Dialog
          open={modal}
          onClose={() => setModal(false)}
          title="Sample confirmation"
          description="Dialogs ask one question and name the action on the button."
          footer={
            <>
              <Button variant="ghost" onClick={() => setModal(false)}>
                Cancel
              </Button>
              <Button onClick={() => setModal(false)}>Confirm</Button>
            </>
          }
        >
          <p>Nothing happens when you confirm; this is the style page.</p>
        </Dialog>
      </Section>

      <Section
        id="ds-states"
        title="Loading and empty states"
        note="Skeletons are shaped like the content they stand in for and stop pulsing for reduced motion."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SkeletonCard variant="stat" label="Loading sample figure" />
          <SkeletonCard variant="media" label="Loading sample event" />
          <Card padding="md">
            <Skeleton className="mb-3 h-5 w-1/2" />
            <SkeletonText lines={4} />
          </Card>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <EmptyState
            icon={Building2}
            tone="teal"
            title="No venues yet"
            hint="Add the place your events happen, then draw its seating if it has reserved seats."
            action={<Button icon={Plus}>Add a venue</Button>}
            secondaryAction={<Button variant="ghost">How seating works</Button>}
          />
          <EmptyState
            icon={Inbox}
            title="Nothing needs you"
            hint="The neutral version, for a quiet list."
            compact
          />
        </div>
      </Section>
    </div>
  );
}
