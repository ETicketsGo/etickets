import { CircleCheck, Lock, RotateCcw, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { editLabel, type Editability, type EditKind } from '@/lib/event-editability';

/**
 * Whether a group of fields can change now, said in words beside the fields.
 *
 * Every lock on the event pages used to be a greyed control or a button that was simply not
 * there. This says which of three states the group is in, and why. See lib/event-editability.
 */
const LOOK: Record<EditKind, { icon: LucideIcon; box: string; mark: string }> = {
  editable: {
    icon: CircleCheck,
    box: 'border-status-success/40 bg-tint-success',
    mark: 'text-status-success',
  },
  review: {
    icon: RotateCcw,
    box: 'border-status-warning/40 bg-tint-warning',
    mark: 'text-status-warning',
  },
  locked: { icon: Lock, box: 'border-border bg-background-subtle', mark: 'text-text-muted' },
};

export function EditStateNote({
  state,
  id,
  children,
}: {
  state: Editability;
  id?: string;
  /** An action that goes with the note, such as "Pause sales and edit". */
  children?: ReactNode;
}) {
  const look = LOOK[state.kind];
  const Icon = look.icon;
  return (
    <div
      id={id}
      role="note"
      data-edit-state={state.kind}
      className={`rounded-md border px-3 py-2 text-caption text-text-primary ${look.box}`}
    >
      <p className="flex items-start gap-2">
        <Icon aria-hidden="true" className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${look.mark}`} />
        <span className="min-w-0">
          <span className="font-semibold">{editLabel(state.kind)}.</span> {state.note}
        </span>
      </p>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}
