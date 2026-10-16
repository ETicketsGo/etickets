// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VenueMap, type VenueMapDrawing } from './venue-map';
import type { VenuePoint, VenueSectionSummary } from './api';

/*
  The owner could move, turn and copy blocks, but not DRAW one where the seats are. What must
  hold: with `draw` set, a drag on the map reports a rectangle and each tap a corner, in map
  units; tapping the first corner again closes the outline; and while drawing, a press on a
  block neither chooses it nor moves it. Without `draw`, the map behaves as before.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const block: VenueSectionSummary = {
  id: '0',
  kind: 'SECTION',
  name: 'Front 1',
  shape: [
    [100, 100],
    [300, 100],
    [300, 300],
    [100, 300],
  ],
  labelX: 200,
  labelY: 200,
  tier: null,
  rotationDeg: 0,
  availableCount: 50,
  totalCount: 50,
  priceMinorFrom: 7500,
  priceMinorTo: 7500,
  colorHex: '#B45309',
  categoryName: 'Premium',
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

/** Renders the editor's map on a 500px box, so one pixel is two map units. */
function mount(props: {
  draw?: VenueMapDrawing;
  onSelect?: (id: string) => void;
  onMove?: () => void;
}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <VenueMap
        focal={{ kind: 'STAGE_END', label: 'STAGE', shape: null }}
        sections={[block]}
        onSelect={props.onSelect ?? (() => undefined)}
        formatPrice={(m) => `$${m / 100}`}
        frame="canvas"
        onMoveBlock={props.onMove ? () => props.onMove?.() : undefined}
        draw={props.draw}
      />,
    ),
  );
  const svg = host.querySelector('svg[role="group"]') as SVGSVGElement;
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500, x: 0, y: 0 }) as DOMRect;
  return svg;
}

/** A pointer event as a browser sends it: React reads pointerId and pointerType off it. */
function pointer(target: Element, type: string, x: number, y: number, id = 1) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(e, 'pointerId', { value: id });
  Object.defineProperty(e, 'pointerType', { value: 'mouse' });
  act(() => {
    target.dispatchEvent(e);
  });
}

const tap = (target: Element, x: number, y: number) => {
  pointer(target, 'pointerdown', x, y);
  pointer(target, 'pointerup', x, y);
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

function drawing(points: VenuePoint[] = []) {
  const calls = {
    rect: [] as [VenuePoint, VenuePoint][],
    corners: [] as VenuePoint[],
    closed: 0,
  };
  const draw: VenueMapDrawing = {
    points,
    onRectangle: (a, b) => calls.rect.push([a, b]),
    onCorner: (p) => calls.corners.push(p),
    onClose: () => {
      calls.closed += 1;
    },
  };
  return { draw, calls };
}

describe('drawing a block on the venue map', () => {
  it('reports a dragged rectangle in map units, from where the drag started to where it ended', () => {
    const { draw, calls } = drawing();
    const svg = mount({ draw });
    pointer(svg, 'pointerdown', 300, 350);
    pointer(svg, 'pointermove', 340, 380);
    expect(svg.querySelector('[data-testid="venue-map-sketch"]')).not.toBeNull();
    pointer(svg, 'pointermove', 400, 450);
    pointer(svg, 'pointerup', 400, 450);
    expect(calls.rect).toEqual([
      [
        [600, 700],
        [800, 900],
      ],
    ]);
    expect(calls.corners).toEqual([]);
  });

  it('places a corner for each tap, and closes the outline on a tap at the first corner', () => {
    const first = drawing();
    let svg = mount({ draw: first.draw });
    tap(svg, 300, 350);
    expect(first.calls.corners).toEqual([[600, 700]]);
    act(() => root?.unmount());

    const three = drawing([
      [600, 700],
      [800, 700],
      [700, 900],
    ]);
    svg = mount({ draw: three.draw });
    expect(svg.querySelectorAll('[data-corner]').length).toBe(3);
    tap(svg, 302, 352); // within a fingertip of the first corner (300, 350)
    expect(three.calls.closed).toBe(1);
    expect(three.calls.corners).toEqual([]);
  });

  it('never chooses or moves a block while drawing, even when the press lands on one', () => {
    const picked: string[] = [];
    let moved = 0;
    const { draw, calls } = drawing();
    const svg = mount({ draw, onSelect: (id) => picked.push(id), onMove: () => (moved += 1) });
    const polygon = svg.querySelector('[data-section-id="0"]') as Element;
    tap(polygon, 100, 100);
    pointer(polygon, 'pointerdown', 100, 100);
    pointer(svg, 'pointermove', 140, 120);
    pointer(svg, 'pointerup', 140, 120);
    expect(picked).toEqual([]);
    expect(moved).toBe(0);
    expect(calls.corners).toEqual([[200, 200]]);
    expect(calls.rect).toEqual([
      [
        [200, 200],
        [280, 240],
      ],
    ]);
    expect(svg.getAttribute('data-drawing')).toBe('true');
  });

  it('without draw, a tap on a block chooses it and a tap on empty ground does nothing', () => {
    const picked: string[] = [];
    const svg = mount({ onSelect: (id) => picked.push(id) });
    expect(svg.querySelector('[data-testid="venue-map-drawing"]')).toBeNull();
    tap(svg.querySelector('[data-section-id="0"]') as Element, 100, 100);
    expect(picked).toEqual(['0']);
  });
});
