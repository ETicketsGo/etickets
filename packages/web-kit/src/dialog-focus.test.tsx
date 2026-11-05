// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Dialog } from './components';
import { BrandButton } from './brand';

/*
  Where focus goes when a Dialog closes. By default, back to whatever had focus when it
  opened: every existing caller relies on that. `returnFocusRef` overrides it for a dialog
  opened after an async action, when the opener was disabled and focus had dropped to <body>.
*/

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

function Harness({
  open,
  opener,
  target,
}: {
  open: boolean;
  opener: React.RefObject<HTMLButtonElement>;
  target?: React.RefObject<HTMLButtonElement>;
}) {
  return (
    <>
      <BrandButton ref={opener} data-testid="opener">
        Open
      </BrandButton>
      <button ref={target} type="button" data-testid="target">
        Target
      </button>
      <Dialog open={open} onClose={() => {}} title="Title" returnFocusRef={target}>
        <button type="button">Inside</button>
      </Dialog>
    </>
  );
}

async function mount(open: boolean, opener: never, target?: never) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(<Harness open={open} opener={opener} target={target} />));
}

describe('Dialog focus on close', () => {
  it('BrandButton forwards its ref to the button', async () => {
    const opener = createRef<HTMLButtonElement>();
    await mount(false, opener as never);
    expect(opener.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('by default, gives focus back to what had it when the dialog opened', async () => {
    const opener = createRef<HTMLButtonElement>();
    await mount(false, opener as never);
    opener.current!.focus();
    await mount(true, opener as never);
    expect(document.activeElement?.textContent).toBe('Inside');
    await mount(false, opener as never);
    expect(document.activeElement).toBe(opener.current);
  });

  it('with returnFocusRef, gives focus to that element instead (even if <body> had it)', async () => {
    const opener = createRef<HTMLButtonElement>();
    const target = createRef<HTMLButtonElement>();
    await mount(false, opener as never, target as never);
    expect(document.activeElement).toBe(document.body);
    await mount(true, opener as never, target as never);
    await mount(false, opener as never, target as never);
    expect(document.activeElement).toBe(target.current);
  });
});
