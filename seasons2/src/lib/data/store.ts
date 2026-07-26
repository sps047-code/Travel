// ============================================================================
// Store — the SINGLE data-access layer (REQUIREMENTS §2 A1/A2/A6).
//
//  - There is exactly one in-memory Trip. Nothing mutates it directly; every
//    change goes through a method here that VALIDATES the result (schema +
//    invariants) and only commits if valid. An invalid mutation is refused and
//    the store is unchanged (P2 — no persisted corruption to heal later).
//  - Svelte store contract (subscribe) so the UI re-renders off one source (A6).
//  - Structural time changes re-run the capped cascade; a geographically silly
//    order is auto-reordered (I4). Location self-heal by name is available via
//    healLocations(geocoder).
// ============================================================================

import type { Trip, Day, Stop, GeoPoint } from './model';
import { genId } from './ids';
import { validateTrip, isValidTripShape } from './schema';
import { recalcDay, dayStartAnchor, reorderByProximity } from '../core/schedule';
import { coordHasDrifted } from '../core/geo';

export type Result = { ok: true } | { ok: false; errors: string[] };
type Subscriber = (t: Trip) => void;

export interface Geocoder {
  /** Resolve a place name to a coordinate, or null if not found. */
  geocode(name: string): Promise<GeoPoint | null>;
}

export interface StoreOptions {
  persistKey?: string; // localStorage key; omit to disable persistence
}

export interface TripStore {
  subscribe(run: Subscriber): () => void;
  get(): Trip;
  /** Adopt a whole trip (e.g. from cloud/import) — validated first (I9). */
  setTrip(input: unknown): Result;
  addStop(dayId: string, input: Partial<Stop> & { name: string; type: Stop['type'] }): Result;
  updateStop(stopId: string, patch: Partial<Stop>): Result;
  deleteStop(stopId: string): Result;
  moveStop(stopId: string, dir: -1 | 1): Result;
  optimizeDay(dayId: string): Result;
  /** Re-locate stops from their names; replaces missing/ drifted coordinates. */
  healLocations(geocoder: Geocoder): Promise<number>;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function findDay(trip: Trip, dayId: string): Day | undefined {
  return trip.days.find((d) => d.id === dayId);
}
function findStopLoc(trip: Trip, stopId: string): { day: Day; idx: number } | null {
  for (const day of trip.days) {
    const idx = day.stops.findIndex((s) => s.id === stopId);
    if (idx >= 0) return { day, idx };
  }
  return null;
}

export function createTripStore(initial: Trip, opts: StoreOptions = {}): TripStore {
  let trip: Trip = clone(initial);
  const subs = new Set<Subscriber>();

  function persist(): void {
    if (!opts.persistKey || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(opts.persistKey, JSON.stringify(trip));
    } catch {
      /* quota / private mode — ignore */
    }
  }

  function notify(): void {
    for (const run of subs) run(trip);
  }

  /** Validate a candidate trip; commit + persist + notify only if valid. */
  function commit(next: Trip): Result {
    const res = validateTrip(next);
    if (!res.ok) return { ok: false, errors: res.errors };
    trip = res.value;
    persist();
    notify();
    return { ok: true };
  }

  return {
    subscribe(run) {
      subs.add(run);
      run(trip);
      return () => subs.delete(run);
    },
    get() {
      return trip;
    },

    setTrip(input) {
      if (!isValidTripShape(input)) {
        return { ok: false, errors: ['not a valid trip (adoption refused)'] };
      }
      return commit(input as Trip);
    },

    addStop(dayId, input) {
      const next = clone(trip);
      const day = findDay(next, dayId);
      if (!day) return { ok: false, errors: [`no day ${dayId}`] };
      const { id: _ignore, ...rest } = input as Partial<Stop>;
      const stop: Stop = {
        location: null,
        startTime: null,
        endTime: null,
        ...rest,
        id: genId('s'), // always a fresh id; never taken from the input
        name: input.name,
        type: input.type,
      };
      // Append and validate. Times are the user's; recalc only happens on an
      // explicit move/optimize, so an edit never silently rewrites the clock.
      day.stops.push(stop);
      return commit(next);
    },

    updateStop(stopId, patch) {
      const next = clone(trip);
      const loc = findStopLoc(next, stopId);
      if (!loc) return { ok: false, errors: [`no stop ${stopId}`] };
      const merged: Stop = { ...loc.day.stops[loc.idx]!, ...patch, id: stopId };
      loc.day.stops[loc.idx] = merged;
      return commit(next); // schema rejects an end-before-start etc. — unchanged on failure
    },

    deleteStop(stopId) {
      const next = clone(trip);
      const loc = findStopLoc(next, stopId);
      if (!loc) return { ok: false, errors: [`no stop ${stopId}`] };
      loc.day.stops.splice(loc.idx, 1);
      return commit(next);
    },

    moveStop(stopId, dir) {
      const next = clone(trip);
      const loc = findStopLoc(next, stopId);
      if (!loc) return { ok: false, errors: [`no stop ${stopId}`] };
      const j = loc.idx + dir;
      if (j < 0 || j >= loc.day.stops.length) return { ok: true }; // no-op at edges
      const arr = loc.day.stops;
      [arr[loc.idx], arr[j]] = [arr[j]!, arr[loc.idx]!];
      // Manual move: keep the user's order, just re-flow times (don't auto-reorder).
      const stops = recalcDay(arr, dayStartAnchor(arr));
      next.days = next.days.map((d) => (d.id === loc.day.id ? { ...d, stops } : d));
      return commit(next);
    },

    optimizeDay(dayId) {
      const next = clone(trip);
      const day = findDay(next, dayId);
      if (!day) return { ok: false, errors: [`no day ${dayId}`] };
      const stops = recalcDay(reorderByProximity(day.stops), dayStartAnchor(day.stops));
      next.days = next.days.map((d) => (d.id === dayId ? { ...d, stops } : d));
      return commit(next);
    },

    async healLocations(geocoder) {
      const next = clone(trip);
      let healed = 0;
      for (const day of next.days) {
        for (const s of day.stops) {
          const geo = await geocoder.geocode(s.name).catch(() => null);
          if (!geo) continue;
          if (!s.location) {
            s.location = { ...geo, geocodedFrom: s.name };
            healed++;
          } else if (!s.location.verified && coordHasDrifted(s.location, geo)) {
            s.location = { ...geo, geocodedFrom: s.name };
            healed++;
          }
        }
      }
      if (healed) {
        const res = commit(next);
        if (!res.ok) return 0;
      }
      return healed;
    },
  };
}

/** Build a fresh empty trip. */
export function newTrip(title: string, startDate: string): Trip {
  return {
    id: genId('t'),
    title,
    startDate,
    tripType: 'solo',
    travelers: [],
    days: [],
  };
}

export function newDay(date: string, title: string): Day {
  return { id: genId('d'), date, title, stops: [] };
}
