import { describe, expect, it } from 'vitest';
import {
  consoleState,
  supportContactHref,
  suspendedOrganizations,
  usableOrganizations,
} from './suspension';

const approved = { id: 'a', status: 'APPROVED' };
const pending = { id: 'p', status: 'PENDING' };
const suspended = { id: 's', status: 'SUSPENDED' };

describe('suspended organizations in the console', () => {
  it('closes the console only when every organization is suspended', () => {
    expect(consoleState([suspended])).toBe('suspended');
    expect(consoleState([suspended, { ...suspended, id: 's2' }])).toBe('suspended');
    expect(consoleState([suspended, approved])).toBe('console');
    expect(consoleState([pending])).toBe('console');
  });

  it('is not the suspended screen for somebody with no organization, or while loading', () => {
    expect(consoleState([])).toBe('console');
    expect(consoleState(undefined)).toBe('loading');
  });

  it('keeps a member of several organizations in the ones that are not suspended', () => {
    expect(usableOrganizations([suspended, approved, pending]).map((o) => o.id)).toEqual([
      'a',
      'p',
    ]);
    expect(suspendedOrganizations([suspended, approved]).map((o) => o.id)).toEqual(['s']);
  });

  it('sends support requests to the storefront contact page', () => {
    expect(supportContactHref('https://www.eticketsgo.com')).toBe(
      'https://www.eticketsgo.com/contact',
    );
    expect(supportContactHref('https://qa.eticketsgo.com/')).toBe(
      'https://qa.eticketsgo.com/contact',
    );
    expect(supportContactHref(null)).toBeNull();
  });
});
