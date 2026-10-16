import type { SeatClassNotice } from '@/lib/seat-class-notice';

/**
 * One seat map's regulated-price notice in the create wizard (see `lib/seat-class-notice`).
 *
 * The link opens in a new tab, as every fix link in the wizard does, so the answers typed so
 * far stay on the page while the organizer chooses the classes. Coming back to this tab asks
 * again; "check again" asks at once, for a browser that does not say the tab came back.
 */
export function SeatClassNoticeCard({
  notice,
  id,
  onRecheck,
  rechecking,
}: {
  notice: SeatClassNotice;
  id?: string;
  /** Ask the server again, after the classes were chosen in the other tab. */
  onRecheck?: () => void;
  rechecking?: boolean;
}) {
  return (
    <div
      id={id}
      role="note"
      className="rounded-md border border-status-warning/40 bg-tint-warning p-3 text-sm"
    >
      {/* Ink, not the secondary grey: grey on the warning tint fails AA in dark mode. */}
      <p className="font-semibold text-text-primary">{notice.title}</p>
      <p className="mt-1 text-caption text-text-primary">{notice.body}</p>
      {notice.href && notice.linkLabel ? (
        <a
          href={notice.href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block font-medium text-text-primary underline underline-offset-2"
        >
          {notice.linkLabel} (opens in a new tab)
        </a>
      ) : null}
      {onRecheck && notice.kind === 'MAP_CLASSES' ? (
        <button
          type="button"
          onClick={onRecheck}
          disabled={rechecking}
          className="ml-4 mt-2 inline-block font-medium text-text-primary underline underline-offset-2 disabled:opacity-60"
        >
          {rechecking ? 'Checking...' : 'I have chosen them - check again'}
        </button>
      ) : null}
    </div>
  );
}
