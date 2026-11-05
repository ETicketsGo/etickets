// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandToggle } from './account-brand';
import { useSingleFlight } from '@/lib/use-single-flight';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
  QA certification D-R6: on the notification settings page one tap on "Marketing on Email" sent
  TWO consent saves. The switch sat inside a <label>; a click on the drawn track ran the track's
  own handler AND activated the label, which clicked the input and fired onChange again.
*/

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

function mount(ui: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
}

const track = () => host!.querySelector('span[aria-hidden="true"]') as HTMLElement;
const input = () => host!.querySelector('input[role="switch"]') as HTMLInputElement;

describe('BrandToggle: one user action is one change', () => {
  it('inside a <label>, a click on the drawn track fires onChange exactly once', () => {
    const onChange = vi.fn();
    mount(
      <label>
        <span>Email</span>
        <BrandToggle checked={false} onChange={onChange} aria-label="Marketing on Email" />
      </label>,
    );
    act(() => track().click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('inside a <label>, a click on the label text fires onChange exactly once', () => {
    const onChange = vi.fn();
    mount(
      <label>
        <span data-testid="text">Email</span>
        <BrandToggle checked={false} onChange={onChange} aria-label="Marketing on Email" />
      </label>,
    );
    act(() => (host!.querySelector('[data-testid="text"]') as HTMLElement).click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('without a label, a click on the track still fires once', () => {
    const onChange = vi.fn();
    mount(<BrandToggle checked onChange={onChange} aria-label="Offers" />);
    act(() => track().click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('the keyboard path (the real input) fires once', () => {
    const onChange = vi.fn();
    mount(
      <label>
        <span>Email</span>
        <BrandToggle checked={false} onChange={onChange} aria-label="Marketing on Email" />
      </label>,
    );
    act(() => input().click());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a disabled switch ignores the track', () => {
    const onChange = vi.fn();
    mount(
      <label>
        <BrandToggle checked={false} disabled onChange={onChange} aria-label="x" />
      </label>,
    );
    act(() => track().click());
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('useSingleFlight: concurrent saves of one switch', () => {
  it('a second call for the same key while the first is saving is ignored; after it settles a new one runs', async () => {
    let once!: ReturnType<typeof useSingleFlight>;
    function Probe() {
      once = useSingleFlight();
      return null;
    }
    mount(<Probe />);
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (release = r)));
    const first = once('consent:email', run);
    const second = once('consent:email', run);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    // A different switch is not blocked.
    const other = once('consent:push', () => Promise.resolve());
    expect(other).not.toBeNull();
    release();
    await first;
    expect(once('consent:email', () => Promise.resolve())).not.toBeNull();
  });

  it('a failed save releases the key', async () => {
    let once!: ReturnType<typeof useSingleFlight>;
    function Probe() {
      once = useSingleFlight();
      return null;
    }
    mount(<Probe />);
    await once('k', () => Promise.reject(new Error('500')))?.catch(() => undefined);
    expect(once('k', () => Promise.resolve())).not.toBeNull();
  });
});
