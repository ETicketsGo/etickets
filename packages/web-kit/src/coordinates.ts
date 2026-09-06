/**
 * Coordinates, out of whatever somebody pasted.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The venue form asked for Latitude and Longitude in two empty boxes. Nobody knows their
 * venue's coordinates, so anyone filling them in goes to a map and comes back with one of a
 * handful of shapes — a Google Maps URL, a "17.3850, 78.4867" pair off the right-click menu,
 * or "17.3850° N, 78.4867° E" off a web page. None of those go in either box, and pasting one
 * fails as an unparsed number rather than saying so.
 *
 * Parsing is the whole feature. There is no maps API key here and no request to a third party
 * — a venue's address is not something to send to Google on every keystroke to save a person
 * one copy-paste.
 *
 * ── WHAT IT REFUSES ────────────────────────────────────────────────────────────────
 * Anything out of range, and anything with no numbers in it. It returns null rather than a
 * best guess: a wrong pin puts a venue in the sea, and an empty field is a far better answer
 * than a confident wrong one for a value that only orders search results.
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Latitude is ±90, longitude ±180. Anything else is not a place. */
function valid(latitude: number, longitude: number): Coordinates | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  // 0,0 is in the Atlantic. It is almost always an empty form rather than a venue.
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

/**
 * Pull a coordinate pair out of free text.
 *
 * Handles, in order: a Google Maps `@lat,lng` path, a `q=`/`ll=`/`query=` parameter, a
 * degrees-with-direction pair, and a bare "lat, lng". The order matters — a Maps URL contains
 * several number pairs, and the one after `@` is the map centre, which is the one the person
 * was looking at.
 */
export function parseCoordinates(input: string): Coordinates | null {
  const text = input.trim();
  if (!text) return null;

  // https://www.google.com/maps/@17.385,78.4867,15z  — the pair after '@' is the centre.
  const atCentre = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text);
  if (atCentre) {
    const found = valid(Number(atCentre[1]), Number(atCentre[2]));
    if (found) return found;
  }

  // ?q=17.385,78.4867 / ?ll=… / ?query=… — what a "share this place" link carries.
  const param =
    /[?&](?:q|ll|query|daddr|center)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i.exec(text);
  if (param) {
    const found = valid(Number(param[1]), Number(param[2]));
    if (found) return found;
  }

  /*
    17.3850° N, 78.4867° E — degrees with a direction letter.

    The letter is the sign, and it can be either order: "78.4867° E, 17.3850° N" is the same
    place written the other way round. Reading the letters rather than the position is what
    makes that work instead of silently swapping the venue's latitude and longitude.
  */
  const directed = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*°?\s*([NSEW])\b/gi)].map((m) => ({
    value: Number(m[1]),
    dir: m[2].toUpperCase(),
  }));
  if (directed.length === 2) {
    const lat = directed.find((d) => d.dir === 'N' || d.dir === 'S');
    const lng = directed.find((d) => d.dir === 'E' || d.dir === 'W');
    if (lat && lng) {
      const found = valid(
        lat.dir === 'S' ? -Math.abs(lat.value) : Math.abs(lat.value),
        lng.dir === 'W' ? -Math.abs(lng.value) : Math.abs(lng.value),
      );
      if (found) return found;
    }
  }

  // A bare pair: "17.3850, 78.4867" or "17.3850 78.4867".
  const bare = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (bare) return valid(Number(bare[1]), Number(bare[2]));

  return null;
}
