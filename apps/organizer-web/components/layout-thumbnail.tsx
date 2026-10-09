import type { LayoutTemplateOutline, VenuePoint } from '@eticketsgo/web-kit';

/**
 * A small picture of a layout template, drawn from the template's own geometry.
 *
 * ── WHY NOT AN ICON ────────────────────────────────────────────────────────────────
 * A drawn picture is a second description of the room, and a second description drifts: the
 * icon says "three tiers" while the template builds two. This draws the outline the API would
 * write - its blocks, its stage or screen, and for a grid every row and aisle - so the picture
 * cannot show a room the template does not build.
 *
 * Grid templates draw seats as dots (aisles left empty, accessible places marked), because the
 * difference between "a cinema" and "a premium cinema" IS the rows. Sectioned templates draw
 * their blocks, because at that size the blocks are the room.
 */

const toPoints = (shape: VenuePoint[]) => shape.map(([x, y]) => `${x},${y}`).join(' ');

function box(shape: VenuePoint[]) {
  const xs = shape.map((p) => p[0]);
  const ys = shape.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * General admission has no template in the API - it builds no seats - so its picture is the
 * one thing it does have: a stage and an open floor.
 */
const GA_STAGE: VenuePoint[] = [
  [250, 60],
  [750, 60],
  [750, 140],
  [250, 140],
];
const GA_FLOOR: VenuePoint[] = [
  [140, 220],
  [860, 220],
  [900, 920],
  [100, 920],
];

export function LayoutThumbnail({
  outline,
  label,
  generalAdmission = false,
}: {
  outline?: LayoutTemplateOutline | null;
  label: string;
  generalAdmission?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 1000 1000"
      role="img"
      aria-label={`Picture of the ${label} layout`}
      className="h-28 w-full rounded-md border border-border bg-background-subtle"
    >
      {generalAdmission ? (
        <>
          <polygon points={toPoints(GA_STAGE)} className="fill-text-primary/80" />
          <polygon
            points={toPoints(GA_FLOOR)}
            className="fill-action-primary/20 stroke-action-primary"
            strokeWidth={8}
            strokeDasharray="28 20"
          />
          <text
            x={500}
            y={600}
            textAnchor="middle"
            className="fill-text-primary text-[90px] font-semibold"
          >
            STANDING
          </text>
        </>
      ) : outline ? (
        <>
          {outline.focal.shape.length >= 3 ? (
            <polygon points={toPoints(outline.focal.shape)} className="fill-text-primary/80" />
          ) : null}
          {outline.sections.map((section) => {
            const colour =
              outline.categories.find((c) => c.name === section.categoryName)?.colorHex ??
              '#64748B';
            if (outline.layoutKind === 'SECTIONED') {
              return (
                <polygon
                  key={section.name}
                  points={toPoints(section.shape)}
                  style={{ fill: colour, fillOpacity: 0.55, stroke: colour }}
                  strokeWidth={4}
                />
              );
            }
            return (
              <GridDots
                key={section.name}
                section={section}
                colour={colour}
                frame={box(section.shape)}
              />
            );
          })}
        </>
      ) : null}
    </svg>
  );
}

/** Every position of a grid block as a dot, aisles left empty and accessible places marked. */
function GridDots({
  section,
  colour,
  frame,
}: {
  section: LayoutTemplateOutline['sections'][number];
  colour: string;
  frame: { x: number; y: number; w: number; h: number };
}) {
  const rows = section.rowLabels.length;
  const across = section.positions;
  if (rows === 0 || across === 0) return null;
  const kindAt = new Map<string, string>();
  for (const k of section.seatKinds) {
    for (const seat of k.seats) kindAt.set(`${k.rowLabel}|${seat}`, k.kind);
  }
  const cellW = frame.w / across;
  const cellH = frame.h / rows;
  const r = Math.max(4, Math.min(cellW, cellH) * 0.36);
  const dots = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < across; col++) {
      const kind = kindAt.get(`${section.rowLabels[row]}|${col + 1}`) ?? 'SEAT';
      if (kind === 'GAP') continue;
      const accessible = kind === 'WHEELCHAIR' || kind === 'COMPANION';
      dots.push(
        <circle
          key={`${row}-${col}`}
          cx={frame.x + (col + 0.5) * cellW}
          cy={frame.y + (row + 0.5) * cellH}
          r={r}
          className={accessible ? 'fill-text-primary' : undefined}
          style={accessible ? undefined : { fill: colour }}
        />,
      );
    }
  }
  return <g>{dots}</g>;
}
