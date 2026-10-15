import { describe, expect, it } from 'vitest';
import { API_URL } from './api';
import { portableImageUrl } from './event-image';

describe('portableImageUrl', () => {
  const path = '/public/events/ev1/images/img1/full';

  it("re-bases the platform's own image route onto this app's API, whatever host saved it", () => {
    expect(portableImageUrl(`http://localhost:4131/api${path}`)).toBe(`${API_URL}${path}`);
    expect(portableImageUrl(`https://api-old-host.up.railway.app/api${path}?v=3`)).toBe(
      `${API_URL}${path}?v=3`,
    );
  });

  it('re-bases an uploaded film poster the same way', () => {
    const poster = '/public/movies/mov1/poster/' + 'a'.repeat(32) + '.webp';
    expect(portableImageUrl(`https://api-qa-f23c.up.railway.app/api${poster}`)).toBe(
      `${API_URL}${poster}`,
    );
  });

  it('leaves any other address alone', () => {
    const cdn = 'https://cdn.example.com/posters/film.jpg';
    expect(portableImageUrl(cdn)).toBe(cdn);
    expect(portableImageUrl('/relative.jpg')).toBe('/relative.jpg');
  });

  it('has nothing to say about nothing', () => {
    expect(portableImageUrl(null)).toBeNull();
    expect(portableImageUrl('')).toBeNull();
  });
});
