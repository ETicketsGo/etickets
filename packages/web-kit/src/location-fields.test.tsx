// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LocationFields,
  locationFrom,
  withChosenZone,
  withCountry,
  withRegion,
  zoneStatus,
  type LocationValue,
} from './location-fields';

/*
  The defect: a venue in Meridian, Idaho was saved on America/New_York, because choosing the
  country set the zone to the country's first one and choosing the state did nothing. What
  must hold: the zone follows the state unless the person picked one; a picked zone sticks;
  and the form says which zone in words a person reads.
*/
describe('the zone follows the state', () => {
  const us = withCountry(
    { country: 'India', region: '', timezone: 'Asia/Kolkata' },
    'United States',
  );

  it('moves to the state zone when the state is chosen, and again when it changes', () => {
    const idaho = withRegion(us, 'Idaho');
    expect(idaho.timezone).toBe('America/Boise');
    expect(withRegion(idaho, 'Texas').timezone).toBe('America/Chicago');
    expect(withRegion(idaho, 'Arizona').timezone).toBe('America/Phoenix');
    expect(withRegion(withCountry(us, 'Canada'), 'Ontario').timezone).toBe('America/Toronto');
  });

  it('keeps a zone the person picked, whatever state comes after', () => {
    const picked = withChosenZone(withRegion(us, 'Texas'), 'America/Los_Angeles');
    expect(withRegion(picked, 'Idaho').timezone).toBe('America/Los_Angeles');
    expect(zoneStatus(withRegion(picked, 'Idaho')).sentence).toBe(
      'Pacific time (Los Angeles), chosen by you. Idaho usually keeps Mountain time (Boise).',
    );
  });

  it('forgets the pick when the country changes, because the old zone cannot apply', () => {
    const picked = withChosenZone(withRegion(us, 'Texas'), 'America/Denver');
    const canada = withCountry(picked, 'Canada');
    expect(canada.timezoneChosen).toBeFalsy();
    expect(withRegion(canada, 'Yukon').timezone).toBe('America/Whitehorse');
  });

  it('leaves India on India time, with or without a state', () => {
    const india = withCountry(us, 'India');
    expect(india.timezone).toBe('Asia/Kolkata');
    expect(withRegion(india, 'Telangana').timezone).toBe('Asia/Kolkata');
    expect(zoneStatus(withRegion(india, 'Telangana')).sentence).toBe('India time (Kolkata).');
  });

  it('says where the zone came from, and that it is only a placeholder before a state', () => {
    expect(zoneStatus(us).sentence).toBe(
      'Eastern time (New York) for now. Choose the state and it is set from there.',
    );
    expect(zoneStatus(withRegion(us, 'Idaho')).sentence).toBe('Mountain time (Boise), from Idaho.');
  });

  it('does not flag another name for the same clock', () => {
    // A Boise venue stored as America/Denver sells every show at the right time.
    const stored = locationFrom({
      country: 'United States',
      region: 'Idaho',
      timezone: 'America/Denver',
    });
    expect(zoneStatus(stored).conflict).toBe(false);
  });

  it('points out a stored zone that contradicts the state, without rewriting it', () => {
    // The QA venue "Walk E1 Venue": Idaho, saved on New York time.
    const stored = locationFrom({
      country: 'United States',
      region: 'Idaho',
      timezone: 'America/New_York',
    });
    expect(stored.timezone).toBe('America/New_York');
    const status = zoneStatus(stored);
    expect(status.conflict).toBe(true);
    expect(status.expected).toBe('America/Boise');
    expect(status.sentence).toContain('Idaho usually keeps Mountain time (Boise)');
  });

  it('fills a missing stored zone from the state rather than the country default', () => {
    expect(locationFrom({ country: 'US', region: 'Idaho', timezone: null }).timezone).toBe(
      'America/Boise',
    );
  });
});

describe('the form, in a browser', () => {
  function mount(initial: LocationValue) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const latest: { value: LocationValue } = { value: initial };
    function Harness() {
      const [value, setValue] = useState(initial);
      latest.value = value;
      return <LocationFields idPrefix="t" value={value} onChange={setValue} />;
    }
    const root = createRoot(host);
    act(() => root.render(<Harness />));
    const pick = (id: string, v: string) =>
      act(() => {
        const el = host.querySelector<HTMLSelectElement>(`#${id}`)!;
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    const summary = () => host.querySelector('[data-testid="t-timezone-summary"]')!.textContent;
    const click = (label: string) =>
      act(() => {
        const b = [...host.querySelectorAll('button')].find((x) => x.textContent === label)!;
        b.click();
      });
    return { host, latest, pick, summary, click, unmount: () => act(() => root.unmount()) };
  }

  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  it('sets Boise for Idaho as soon as the state is picked, and says so', () => {
    const f = mount({ country: 'India', region: '', timezone: 'Asia/Kolkata' });
    f.pick('t-country', 'United States');
    f.pick('t-region', 'Idaho');
    expect(f.latest.value.timezone).toBe('America/Boise');
    expect(f.summary()).toContain('Time zone: Mountain time (Boise), from Idaho.');
    f.unmount();
  });

  it('keeps a zone picked through Change when the state changes afterwards', () => {
    const f = mount({ country: 'United States', region: 'Texas', timezone: 'America/Chicago' });
    expect(f.host.querySelector('#t-timezone')).toBeNull();
    f.click('Change');
    f.pick('t-timezone', 'America/Los_Angeles');
    f.pick('t-region', 'New Mexico');
    expect(f.latest.value).toMatchObject({ timezone: 'America/Los_Angeles', timezoneChosen: true });
    f.pick('t-region', 'Idaho');
    expect(f.latest.value.timezone).toBe('America/Los_Angeles');
    expect(f.summary()).toContain('chosen by you. Idaho usually keeps Mountain time (Boise).');
    f.click('Use Mountain time (Boise)');
    expect(f.latest.value).toMatchObject({ timezone: 'America/Boise', timezoneChosen: false });
    f.unmount();
  });
});
