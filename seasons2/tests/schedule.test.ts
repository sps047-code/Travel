import { describe, it, expect } from 'vitest';
import type { Stop, StopType } from '../src/lib/data/model';
import {
  recalcDay, visitMins, isLegFeasible, chronoViolations,
  reorderByProximity, routeMiles, routeIsInefficient, DAY_END_CAP_MINS,
} from '../src/lib/core/schedule';
import { parseTimeMins } from '../src/lib/core/time';

let n = 0;
function stop(p: Partial<Stop> & { type?: StopType }): Stop {
  return {
    id: `s${n++}`,
    name: 'Stop',
    type: 'sight',
    location: null,
    startTime: null,
    endTime: null,
    ...p,
  };
}

describe('visitMins prefers the derived span', () => {
  it('uses end-start when present', () => {
    expect(visitMins(stop({ startTime: '9:00AM', endTime: '10:30AM' }))).toBe(90);
  });
  it('falls back to a per-type default when untimed', () => {
    expect(visitMins(stop({ type: 'food' }))).toBe(75);
  });
});

describe('recalcDay never lands in the small hours (the 2:26 AM bug)', () => {
  it('caps a corrupt far-away coordinate and never crosses midnight', () => {
    const day = [
      stop({ name: 'Lunch', type: 'food', startTime: '12:00PM', endTime: '12:45PM',
             location: { lat: 55.95, lng: -3.19 } }),
      // A corrupt coordinate on the far side of the planet -> ~half the globe away.
      stop({ name: 'Corrupt', type: 'sight', location: { lat: -40, lng: 175 } }),
      stop({ name: 'Dinner', type: 'food', location: { lat: 55.96, lng: -3.18 } }),
    ];
    const out = recalcDay(day);
    for (const s of out) {
      const m = parseTimeMins(s.startTime)!;
      expect(m).toBeGreaterThanOrEqual(4 * 60); // no small-hours start
      expect(m).toBeLessThanOrEqual(DAY_END_CAP_MINS);
    }
    // Chronological and each start after the previous.
    expect(chronoViolations(out)).toEqual([]);
  });

  it('preserves each stop span and keeps order when a stop moves', () => {
    const day = [
      stop({ name: 'A', startTime: '9:00AM', endTime: '10:00AM', location: { lat: 55.95, lng: -3.19 } }),
      stop({ name: 'B', startTime: '11:00AM', endTime: '11:30AM', location: { lat: 55.96, lng: -3.20 } }),
    ];
    const out = recalcDay(day, 9 * 60);
    // A keeps its 60-min span, B keeps its 30-min span.
    expect(parseTimeMins(out[0]!.endTime)! - parseTimeMins(out[0]!.startTime)!).toBe(60);
    expect(parseTimeMins(out[1]!.endTime)! - parseTimeMins(out[1]!.startTime)!).toBe(30);
    expect(chronoViolations(out)).toEqual([]);
  });
});

describe('feasibility (I2)', () => {
  it('flags a stop that cannot be reached in time', () => {
    const prev = stop({ name: 'Lunch', startTime: '12:00PM', endTime: '12:45PM',
                        location: { lat: 55.95, lng: -3.19 } });
    // ~112 mi away but scheduled only 45 min later -> impossible.
    const next = stop({ name: 'Far', startTime: '1:30PM', location: { lat: 56.8758, lng: -5.431 } });
    expect(isLegFeasible(prev, next)).toBe(false);
  });
  it('accepts a reachable stop', () => {
    const prev = stop({ name: 'A', startTime: '9:00AM', endTime: '10:00AM',
                        location: { lat: 55.95, lng: -3.19 } });
    const next = stop({ name: 'B', startTime: '10:30AM', location: { lat: 55.96, lng: -3.20 } });
    expect(isLegFeasible(prev, next)).toBe(true);
  });
});

describe('auto-reorder reduces backtracking (I4)', () => {
  it('a zigzag route is detected and improved', () => {
    // Edinburgh -> far NW -> back central -> back NW  (nonsensical)
    const zig = [
      stop({ name: 'Edinburgh', location: { lat: 55.95, lng: -3.19 } }),
      stop({ name: 'Glenfinnan', location: { lat: 56.8758, lng: -5.431 } }),
      stop({ name: 'Stirling', location: { lat: 56.12, lng: -3.94 } }),
      stop({ name: 'Glencoe', location: { lat: 56.6779, lng: -5.0974 } }),
    ];
    expect(routeIsInefficient(zig)).toBe(true);
    const fixed = reorderByProximity(zig);
    expect(routeMiles(fixed)).toBeLessThan(routeMiles(zig));
  });
  it('keeps lodging pinned as the overnight bookend', () => {
    const day = [
      stop({ name: 'Start', location: { lat: 55.95, lng: -3.19 } }),
      stop({ name: 'X', location: { lat: 56.8, lng: -5.4 } }),
      stop({ name: 'Y', location: { lat: 56.1, lng: -3.9 } }),
      stop({ name: 'Hotel', type: 'lodging', location: { lat: 55.95, lng: -3.19 } }),
    ];
    const out = reorderByProximity(day);
    expect(out[out.length - 1]!.name).toBe('Hotel');
  });
});
