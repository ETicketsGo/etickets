import { describe, expect, it } from 'vitest';
import {
  FULL_CANVAS,
  MAX_ZOOM,
  clampView,
  frameAround,
  homeView,
  panBy,
  pointAt,
  viewBoxOf,
  zoomTo,
  type MapPoint,
} from './venue-map-view';

/*
  On a 390px phone the venue map's labels rendered at 7-9px: unreadable. The frame and the zoom
  are what make them larger, so what must hold: the frame fits the venue (not the empty canvas),
  zooming keeps the point under the fingers where it is, and no view ever leaves the venue.
*/

// The amphitheatre: blocks in the top half of the canvas, the stage above them.
const amphitheatre: MapPoint[][] = [
  [
    [80, 60],
    [920, 60],
    [920, 620],
    [80, 620],
  ],
];

describe('venue map view', () => {
  it('frames the venue, not the empty canvas around it', () => {
    const frame = frameAround(amphitheatre);
    expect(frame).toEqual({ x: 56, y: 36, w: 888, h: 608 });
    // Shown at the same width, everything is about 1.13x larger than in the 1000-wide canvas,
    // and the box is shorter, so nothing below the venue is wasted screen.
    expect(1000 / frame.w).toBeGreaterThan(1.1);
    expect(frame.h).toBeLessThan(frame.w);
  });

  it('never blows one small block up to fill the screen, and falls back to the canvas', () => {
    const tiny = frameAround([
      [
        [500, 500],
        [520, 500],
        [520, 520],
      ],
    ]);
    expect(tiny.w).toBeGreaterThanOrEqual(333);
    expect(tiny.h).toBeGreaterThanOrEqual(333);
    expect(frameAround([])).toEqual(FULL_CANVAS);
  });

  it('zooms around the point under the fingers and keeps it there', () => {
    const frame = frameAround(amphitheatre);
    const home = homeView(frame);
    // Fingers a quarter of the way across, a third of the way down.
    const at: MapPoint = [0.25, 1 / 3];
    const anchor = pointAt(frame, home, 0.25 * 300, (1 / 3) * 300 * (frame.h / frame.w), 300);
    const zoomed = zoomTo(frame, 2, anchor, at);
    expect(zoomed.scale).toBe(2);
    const vb = viewBoxOf(frame, zoomed);
    expect(vb.w).toBeCloseTo(frame.w / 2);
    // The same map point is still a quarter across and a third down the box.
    expect((anchor[0] - vb.x) / vb.w).toBeCloseTo(0.25, 5);
    expect((anchor[1] - vb.y) / vb.h).toBeCloseTo(1 / 3, 5);
  });

  it('keeps zoom between whole-venue and the most useful close-up', () => {
    const frame = frameAround(amphitheatre);
    expect(zoomTo(frame, 0.2, [500, 300]).scale).toBe(1);
    expect(zoomTo(frame, 99, [500, 300]).scale).toBe(MAX_ZOOM);
  });

  it('never pans past the edge of the venue', () => {
    const frame = frameAround(amphitheatre);
    const zoomed = zoomTo(frame, 2, [500, 300]);
    const far = panBy(frame, zoomed, 5000, 5000, 300);
    const vb = viewBoxOf(frame, far);
    expect(vb.x).toBeCloseTo(frame.x);
    expect(vb.y).toBeCloseTo(frame.y);
    // Unzoomed there is nowhere to pan to.
    const home = homeView(frame);
    expect(clampView(frame, { ...home, cx: home.cx + 300 })).toEqual(home);
  });
});
