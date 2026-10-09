import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEventDraft, readEventDraft, saveEventDraft } from './event-draft';

/**
 * The saved draft is one localStorage key shared by every organization in the browser. The
 * wizard now clears it whenever the form is blank, so clearing has to stay inside the
 * organization it was asked for - or opening the wizard for one organization would throw away
 * a half-written event in another.
 */
describe('clearing a saved draft', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('leaves another organization draft alone', () => {
    saveEventDraft('org-a', { title: 'Jazz' });
    clearEventDraft('org-b');
    expect(readEventDraft('org-a')?.data).toEqual({ title: 'Jazz' });
  });

  it('clears the draft of the organization it is asked for', () => {
    saveEventDraft('org-a', { title: 'Jazz' });
    clearEventDraft('org-a');
    expect(readEventDraft('org-a')).toBeNull();
  });

  it('clears whatever is there when no organization is named', () => {
    saveEventDraft('org-a', { title: 'Jazz' });
    clearEventDraft();
    expect(readEventDraft('org-a')).toBeNull();
  });
});
