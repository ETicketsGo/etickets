import type { SeatingRoom } from '@eticketsgo/web-kit';

/**
 * What the create wizard says about a seat map on a cinema screen, before the event exists.
 *
 * ── WHY THE WIZARD SAYS IT ─────────────────────────────────────────────────────────
 * A seated event on a cinema screen whose seat categories had no regulatory class was created
 * with "Setup complete" and then could not sell: the refusal only appeared on the event page
 * afterwards. The server now answers, per seat map, what the regulated-price rules need
 * (`SeatingRoom.seatClasses`); this turns that answer into one sentence and the one place to
 * fix it. A space that is not a cinema screen, or a place with no price rules, says nothing.
 */
export interface SeatClassNotice {
  /** MAP_CLASSES is the organizer's to fix; NO_RULES and BLOCKED are not. */
  kind: 'MAP_CLASSES' | 'NO_RULES' | 'BLOCKED';
  title: string;
  body: string;
  /** The control that fixes it. Null when nothing the organizer can open would. */
  href: string | null;
  linkLabel: string | null;
}

const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export function seatClassNotice(
  room: Pick<SeatingRoom, 'name' | 'seatClasses'> | null | undefined,
): SeatClassNotice | null {
  const need = room?.seatClasses;
  if (!room || !need || need.state === 'NONE') return null;
  if (need.state === 'MAP_CLASSES') {
    const one = need.unmapped.length === 1;
    return {
      kind: 'MAP_CLASSES',
      title: `${list(need.unmapped)} ${one ? 'needs' : 'need'} a seat class`,
      body:
        `${room.name} is a cinema screen in a state that sets the most a ticket may cost for ` +
        `each class of seat. Tickets in ${one ? 'this seat category' : 'these seat categories'} ` +
        'cannot be sold until you choose its class. You can create the event now and do it after.',
      href: need.fixPath,
      linkLabel: 'Choose seat classes',
    };
  }
  if (need.state === 'NO_RULES') {
    return {
      kind: 'NO_RULES',
      title: 'Cinema screens here cannot sell online yet',
      body:
        `${room.name} is a cinema screen, and there are no state ticket price rules on record ` +
        'for this place yet, so no ticket can be sold there online. Choosing seat classes will ' +
        'not change this. To sell now, choose a space that is not a cinema screen.',
      href: null,
      linkLabel: null,
    };
  }
  return {
    kind: 'BLOCKED',
    title: 'This cinema screen cannot sell yet',
    body: `The price rules for ${room.name} cannot be applied yet. Its readiness page says why.`,
    href: need.fixPath,
    linkLabel: 'Open readiness',
  };
}
