// ============================================================================
// Geocoding via OpenStreetMap Nominatim. Implements the Geocoder the store uses
// for name-based location self-heal (§6/G1), plus a search for the editor.
// Results are cached by name so we don't re-hit the service.
// ============================================================================

import type { GeoPoint } from '../data/model';
import type { Geocoder } from '../data/store';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const cache = new Map<string, GeoPoint | null>();

export interface GeoResult {
  label: string;
  point: GeoPoint;
}

/** Strip meal/label prefixes and trailing clauses so "Lunch — Glencoe Café" or
 *  "Check-in — Hub by Premier Inn" geocode by their real place name. */
function cleanName(name: string): string {
  return name
    .replace(/^(check.?in|lunch|dinner|breakfast|depart|arrive)\s*[—–:-]\s*/i, '')
    .replace(/\s*[—–].*$/, '')
    .trim() || name;
}

export async function searchPlaces(query: string, limit = 6): Promise<GeoResult[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ display_name: string; lat: string; lon: string }>;
  return rows.map((r) => ({
    label: r.display_name,
    point: { lat: Number(r.lat), lng: Number(r.lon) },
  }));
}

export const nominatimGeocoder: Geocoder = {
  async geocode(name: string): Promise<GeoPoint | null> {
    const key = cleanName(name).toLowerCase();
    if (cache.has(key)) return cache.get(key)!;
    try {
      const results = await searchPlaces(cleanName(name), 1);
      const point = results[0]?.point ?? null;
      cache.set(key, point);
      return point;
    } catch {
      return null;
    }
  },
};
