import { describe, expect, it } from 'vitest';
import { parseCoordinates } from './coordinates';

/**
 * Whatever somebody actually pastes into the box.
 *
 * The venue form asked for latitude and longitude in two empty fields. Nobody has those to
 * hand, so anyone who fills them in goes to a map and comes back with one of these shapes —
 * and every one of them failed silently as an unparsed number.
 */
describe('parsing a pasted location', () => {
  it('reads a bare pair, comma or space separated', () => {
    expect(parseCoordinates('17.3850, 78.4867')).toEqual({
      latitude: 17.385,
      longitude: 78.4867,
    });
    expect(parseCoordinates('17.3850 78.4867')).toEqual({ latitude: 17.385, longitude: 78.4867 });
    expect(parseCoordinates('  -33.8688,151.2093 ')).toEqual({
      latitude: -33.8688,
      longitude: 151.2093,
    });
  });

  it('takes the map CENTRE out of a Google Maps URL, not the first numbers in it', () => {
    /*
      A Maps URL is full of number pairs — place ids, zoom levels, viewport hints. The one
      after '@' is what the person was looking at, and taking any other would drop a pin
      somewhere they never chose.
    */
    expect(
      parseCoordinates('https://www.google.com/maps/@17.385,78.4867,15z/data=!3m1!4b1'),
    ).toEqual({ latitude: 17.385, longitude: 78.4867 });
  });

  it('reads a shared-place link', () => {
    expect(parseCoordinates('https://maps.google.com/?q=12.9716,77.5946')).toEqual({
      latitude: 12.9716,
      longitude: 77.5946,
    });
  });

  it('reads degrees with a direction, in either order', () => {
    // The letter is the sign. Reading position instead would swap a venue's coordinates
    // whenever somebody pasted longitude first.
    expect(parseCoordinates('17.3850° N, 78.4867° E')).toEqual({
      latitude: 17.385,
      longitude: 78.4867,
    });
    expect(parseCoordinates('78.4867° E, 17.3850° N')).toEqual({
      latitude: 17.385,
      longitude: 78.4867,
    });
    expect(parseCoordinates('33.8688° S, 151.2093° W')).toEqual({
      latitude: -33.8688,
      longitude: -151.2093,
    });
  });

  it('refuses anything that is not a place, rather than guessing', () => {
    // A wrong pin puts a venue in the sea. An empty field is a much better answer than a
    // confident wrong one for a value that only orders search results.
    expect(parseCoordinates('')).toBeNull();
    expect(parseCoordinates('Hyderabad')).toBeNull();
    expect(parseCoordinates('91, 0')).toBeNull(); // latitude out of range
    expect(parseCoordinates('0, 181')).toBeNull(); // longitude out of range
    expect(parseCoordinates('0, 0')).toBeNull(); // the empty-form answer, not a venue
  });

  it('does not half-parse while somebody is still typing', () => {
    expect(parseCoordinates('17.38')).toBeNull();
    expect(parseCoordinates('17.3850,')).toBeNull();
  });
});
