// ============================================================================
// Schedule — pure, tested. The timeline cascade (with the caps that make the
// "moved-stop lands at 2 AM" bug impossible), feasibility detection, and the
// geographic auto-reorder (REQUIREMENTS §5 I1–I4, §7). No DOM, no I/O.
// ============================================================================

import type { Stop, StopType } from '../data/model';
import { isTransit } from '../data/model';
import { parseTimeMins, formatTimeMins, visitSpanMins } from './time';
import { haversine, isValidPoint, travelMins, defaultMode } from './geo';

/** Per-type fallback visit length (minutes) when a stop has no usable span. */
export const DEFAULT_VISIT_MINS: Record<StopType, number> = {
  sight: 90, food: 75, lodging: 30, hike: 120, beach: 120, shop: 60,
  tour: 90, show: 150, flight: 0, train: 0, bus: 0, drive: 20,
};

// Caps that keep any recalculated day inside real waking hours no matter how
// corrupt the inputs are (REQUIREMENTS §5 I3).
export const MAX_LEG_TRAVEL_MINS = 240; // 4h — a day's stops are never 20h apart
export const MAX_VISIT_MINS = 300; // 5h
export const DAY_END_CAP_MINS = 23 * 60 + 45; // 23:45 — clock never wraps to AM
const DAY_START_FALLBACK = 9 * 60; // 9:00 AM
const EARLIEST_SANE_START = 4 * 60; // 4:00 AM

/** Visit length for a stop: its derived span, else a per-type default. */
export function visitMins(stop: Stop): number {
  const span = visitSpanMins(stop.startTime, stop.endTime);
  if (span != null) return Math.min(span, MAX_VISIT_MINS);
  return DEFAULT_VISIT_MINS[stop.type] ?? 60;
}

/** Straight-line travel minutes between two consecutive stops. */
export function legTravelMins(a: Stop, b: Stop): number {
  if (!isValidPoint(a.location) || !isValidPoint(b.location)) return 15;
  const dist = haversine(a.location.lat, a.location.lng, b.location.lat, b.location.lng);
  const mode = b.transitMode ?? defaultMode(a.type, b.type, dist);
  return Math.max(5, travelMins(dist, mode));
}

/** The day's start anchor: the first stop's start if it's a sane hour (>=4 AM),
 *  else the earliest sane start present, else 9:00 AM. Never an absurd time. */
export function dayStartAnchor(stops: Stop[]): number {
  if (!stops.length) return DAY_START_FALLBACK;
  const first = parseTimeMins(stops[0]!.startTime);
  if (first != null && first >= EARLIEST_SANE_START) return first;
  const sane = stops
    .map((s) => parseTimeMins(s.startTime))
    .filter((t): t is number => t != null && t >= EARLIEST_SANE_START);
  if (first == null && sane.length) return Math.min(...sane);
  return DAY_START_FALLBACK;
}

/**
 * Recompute every stop's start/end in chronological order: each stop begins
 * after the previous stop's visit + the travel between them. Each stop's own
 * visit span is preserved; travel and visit are capped; the clock never crosses
 * midnight. Pure: returns NEW stop objects, input untouched.
 */
export function recalcDay(stops: Stop[], anchorMins?: number): Stop[] {
  if (!stops.length) return [];
  let cur = anchorMins != null && anchorMins >= 0 ? anchorMins : dayStartAnchor(stops);
  if (cur > DAY_END_CAP_MINS) cur = DAY_END_CAP_MINS;

  const out: Stop[] = [];
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i]!;
    if (i > 0) {
      const prev = out[i - 1]!;
      const visit = Math.min(visitMins(prev), MAX_VISIT_MINS);
      const travel = Math.min(legTravelMins(stops[i - 1]!, s), MAX_LEG_TRAVEL_MINS);
      cur = Math.min(cur + visit + travel, DAY_END_CAP_MINS);
    }
    const span = Math.min(visitMins(s), MAX_VISIT_MINS);
    const start = cur;
    const end = Math.min(cur + span, DAY_END_CAP_MINS);
    out.push({
      ...s,
      startTime: formatTimeMins(start),
      // Transit keeps whatever end it had if valid; activities always get an end.
      endTime: formatTimeMins(end),
    });
  }
  return out;
}

/** Earliest a stop could START given the previous stop and the leg between. */
export function earliestArrivalMins(prev: Stop, next: Stop): number | null {
  const prevStart = parseTimeMins(prev.startTime);
  if (prevStart == null) return null;
  const prevEnd = parseTimeMins(prev.endTime);
  const depart = prevEnd != null && prevEnd > prevStart ? prevEnd : prevStart + visitMins(prev);
  return depart + legTravelMins(prev, next);
}

/** Is `next`'s scheduled start physically reachable from `prev`? (I2) */
export function isLegFeasible(prev: Stop, next: Stop, slackMins = 10): boolean {
  const earliest = earliestArrivalMins(prev, next);
  const nextStart = parseTimeMins(next.startTime);
  if (earliest == null || nextStart == null) return true; // can't judge -> don't flag
  return nextStart >= earliest - slackMins;
}

/** Indices of stops in a day that are chronologically out of order (I1). */
export function chronoViolations(stops: Stop[]): number[] {
  const bad: number[] = [];
  let last = -1;
  stops.forEach((s, i) => {
    const m = parseTimeMins(s.startTime);
    if (m == null) return;
    if (m < last) bad.push(i);
    else last = m;
  });
  return bad;
}

/** Total straight-line miles along a stop order (located stops only). */
export function routeMiles(stops: Stop[]): number {
  const pts = stops.filter((s) => !s.isAlternate && isValidPoint(s.location));
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += haversine(
      pts[i - 1]!.location!.lat, pts[i - 1]!.location!.lng,
      pts[i]!.location!.lat, pts[i]!.location!.lng,
    );
  }
  return total;
}

/**
 * Reorder a day's stops to reduce backtracking (nearest-neighbour from the
 * first stop), WITHOUT moving pinned stops: transit legs and lodging keep their
 * position (a hotel stays the overnight bookend). Only free activity stops are
 * reordered. Pure: returns a new array. This is the I4 "auto-reorder" primitive.
 */
export function reorderByProximity(stops: Stop[]): Stop[] {
  if (stops.length < 3) return stops.slice();
  const pinned = new Set<number>();
  stops.forEach((s, i) => {
    if (isTransit(s.type) || s.type === 'lodging' || !isValidPoint(s.location)) pinned.add(i);
  });
  // Free (movable) positions, in order.
  const freeIdx = stops.map((_, i) => i).filter((i) => !pinned.has(i));
  if (freeIdx.length < 3) return stops.slice();

  const freeStops = freeIdx.map((i) => stops[i]!);
  // Seed from the stop just before the first free slot if it has a location,
  // else from the first free stop itself.
  const seedAt = freeIdx[0]! - 1;
  const seed = seedAt >= 0 && isValidPoint(stops[seedAt]!.location)
    ? stops[seedAt]!.location!
    : freeStops[0]!.location!;

  const remaining = freeStops.slice();
  const ordered: Stop[] = [];
  let from = seed;
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(from.lat, from.lng, remaining[i]!.location!.lat, remaining[i]!.location!.lng);
      if (d < bestD) { bestD = d; best = i; }
    }
    const picked = remaining.splice(best, 1)[0]!;
    ordered.push(picked);
    from = picked.location!;
  }

  // Stitch the reordered free stops back into their original slots.
  const result = stops.slice();
  freeIdx.forEach((slot, k) => { result[slot] = ordered[k]!; });
  return result;
}

/**
 * Whether a day's current order is meaningfully worse than the proximity order
 * (a "geographically nonsensical" route, I4). Uses a 15% + 10mi threshold so
 * tiny differences don't trigger churn.
 */
export function routeIsInefficient(stops: Stop[]): boolean {
  const current = routeMiles(stops);
  if (current < 10) return false;
  const optimized = routeMiles(reorderByProximity(stops));
  return current > optimized * 1.15 && current - optimized > 10;
}
