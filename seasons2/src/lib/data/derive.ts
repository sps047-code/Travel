// ============================================================================
// Derived reads — pure functions over a Trip/Day/Stop. Nothing here is stored;
// everything is computed so it can never drift from the canonical fields
// (REQUIREMENTS §2 A3). Legs, durations, tonight's hotel, and conflicts.
// ============================================================================

import type { Day, Stop } from './model';
import { isTransit } from './model';
import { durationChip } from '../core/time';
import { haversine, isValidPoint, travelMins, defaultMode } from '../core/geo';
import { isLegFeasible, earliestArrivalMins } from '../core/schedule';
import { formatTimeMins } from '../core/time';

export interface LegInfo {
  miles: number;
  minutes: number;
  mode: string;
  /** Set when the next stop cannot be reached in time (I2). */
  infeasibleEarliest?: string;
}

/** The travel leg between two consecutive located stops, or null. */
export function legBetween(a: Stop, b: Stop): LegInfo | null {
  if (!isValidPoint(a.location) || !isValidPoint(b.location)) return null;
  const miles = haversine(a.location.lat, a.location.lng, b.location.lat, b.location.lng);
  const mode = b.transitMode ?? defaultMode(a.type, b.type, miles);
  const minutes = travelMins(miles, mode);
  const info: LegInfo = { miles, minutes, mode };
  if (!isLegFeasible(a, b)) {
    const earliest = earliestArrivalMins(a, b);
    if (earliest != null) info.infeasibleEarliest = formatTimeMins(earliest);
  }
  return info;
}

/** Duration chip text for a stop (derived from its times). */
export function stopDuration(stop: Stop): string {
  return durationChip(stop.startTime, stop.endTime);
}

/**
 * The hotel you sleep at at the END of a day: a lodging stop within the day
 * (last one), else — because you're continuing a stay — the most recent lodging
 * from earlier days. Never a meal/activity, never a future day's hotel. Returns
 * null on the final day when none is found (heading home). (REQUIREMENTS §4.6, I6)
 */
export function tonightHotel(days: Day[], dayIdx: number): Stop | null {
  const day = days[dayIdx];
  if (!day) return null;
  for (let i = day.stops.length - 1; i >= 0; i--) {
    const s = day.stops[i]!;
    if (s.type === 'lodging') return s;
  }
  for (let d = dayIdx - 1; d >= 0; d--) {
    const stops = days[d]!.stops;
    for (let i = stops.length - 1; i >= 0; i--) {
      if (stops[i]!.type === 'lodging') return stops[i]!;
    }
  }
  return null;
}

/** The hotel you START a day from (checked in on this or an earlier day). */
export function morningHotel(days: Day[], dayIdx: number): Stop | null {
  for (let d = dayIdx; d >= 0; d--) {
    const stops = days[d]!.stops;
    const start = d === dayIdx ? stops.length : stops.length;
    for (let i = start - 1; i >= 0; i--) {
      if (stops[i]!.type === 'lodging') return stops[i]!;
    }
  }
  return null;
}

export interface Conflict {
  stopIndex: number;
  message: string;
}

/** Feasibility/order conflicts for a day, as messages tied to stop indices. */
export function dayConflicts(day: Day): Conflict[] {
  const out: Conflict[] = [];
  const stops = day.stops;
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1]!;
    const cur = stops[i]!;
    const leg = legBetween(prev, cur);
    if (leg?.infeasibleEarliest) {
      out.push({
        stopIndex: i,
        message: `Can't arrive before ${leg.infeasibleEarliest} — not enough time from ${prev.name}.`,
      });
    }
  }
  return out;
}

/** Stops that aren't transit and can be routed on a map (have a real location). */
export function routableStops(day: Day): Stop[] {
  return day.stops.filter((s) => !s.isAlternate && !isTransit(s.type) && isValidPoint(s.location));
}
