// ============================================================================
// Geo — pure, tested. Distance, travel-time model, and the drift check that
// powers name-based location self-heal (REQUIREMENTS §6/§7).
// ============================================================================

import type { GeoPoint, StopType, TransitMode } from '../data/model';
import { isTransit } from '../data/model';

const EARTH_MI = 3959;

/** Great-circle distance in miles. */
export function haversine(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const r = Math.PI / 180;
  const dLa = (bLat - aLat) * r;
  const dLo = (bLng - aLng) * r;
  const s =
    Math.sin(dLa / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLo / 2) ** 2;
  return EARTH_MI * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export function distanceBetween(a: GeoPoint, b: GeoPoint): number {
  return haversine(a.lat, a.lng, b.lat, b.lng);
}

/** A usable coordinate: real numbers in range, and not 0,0 (the "unknown" sink). */
export function isValidPoint(p: GeoPoint | null | undefined): p is GeoPoint {
  return (
    !!p &&
    Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 &&
    !(p.lat === 0 && p.lng === 0)
  );
}

/** Estimated travel minutes for a straight-line distance and mode. Mirrors the
 *  current app's model: drive uses a 1.25 road factor then an adaptive mph. */
export function travelMins(straightLineMiles: number, mode: TransitMode): number {
  const mi = Math.max(0, straightLineMiles);
  switch (mode) {
    case 'flight': return Math.round(mi / 8);
    case 'train': return Math.round(mi / 0.85);
    case 'bus': return Math.round(mi / 0.5);
    case 'walk': return Math.round(mi / 0.05);
    case 'drive':
    default: {
      const road = mi * 1.25;
      const mph = road > 120 ? 65 : road > 40 ? 55 : road > 10 ? 40 : 20;
      return Math.round((road / mph) * 60);
    }
  }
}

/** Default travel mode between two stop types when none is set. */
export function defaultMode(
  fromType: StopType,
  toType: StopType,
  straightLineMiles: number,
): TransitMode {
  if (isTransit(toType)) return toType as TransitMode;
  if (isTransit(fromType)) return fromType as TransitMode;
  return straightLineMiles < 1 ? 'walk' : 'drive';
}

/** Miles a stored coordinate may drift from the name's true geocode before it
 *  is treated as corrupt and replaced (REQUIREMENTS §6/G2, I5). */
export const COORD_DRIFT_MI = 25;

/** Does a stored coordinate disagree with the authoritative one enough to heal?
 *  (Rosslyn-Chapel-ended-up-near-Glencoe was ~90mi.) */
export function coordHasDrifted(stored: GeoPoint, authoritative: GeoPoint): boolean {
  return distanceBetween(stored, authoritative) > COORD_DRIFT_MI;
}
