import { describe, it, expect } from 'vitest';
import type { Day, Stop, StopType } from '../src/lib/data/model';
import {
  legBetween, stopDuration, tonightHotel, dayConflicts,
} from '../src/lib/data/derive';

let n = 0;
function stop(p: Partial<Stop> & { name: string; type?: StopType }): Stop {
  return {
    id: `s${n++}`, type: 'sight',
    location: null, startTime: null, endTime: null, ...p,
  };
}
function day(stops: Stop[], date = '2026-08-10'): Day {
  return { id: `d${n++}`, date, title: 'D', stops };
}

describe('legBetween', () => {
  it('reports miles, minutes and mode for a road leg', () => {
    const a = stop({ name: 'Edinburgh', location: { lat: 55.95, lng: -3.19 } });
    const b = stop({ name: 'Stirling', location: { lat: 56.12, lng: -3.94 } });
    const leg = legBetween(a, b)!;
    expect(leg.miles).toBeGreaterThan(10);
    expect(leg.mode).toBe('drive');
    expect(leg.minutes).toBeGreaterThan(0);
  });
  it('marks an infeasible leg (I2)', () => {
    const a = stop({ name: 'Lunch', startTime: '12:00PM', endTime: '12:45PM',
      location: { lat: 55.95, lng: -3.19 } });
    const b = stop({ name: 'Glenfinnan', startTime: '1:30PM', location: { lat: 56.8758, lng: -5.431 } });
    expect(legBetween(a, b)!.infeasibleEarliest).toBeTruthy();
  });
});

describe('stopDuration is derived', () => {
  it('reflects the times', () => {
    expect(stopDuration(stop({ name: 'X', startTime: '12:08PM', endTime: '12:33PM' }))).toBe('25min');
  });
});

describe('tonightHotel (I6)', () => {
  it('uses a lodging stop within the day', () => {
    const d = day([
      stop({ name: 'Sight' }),
      stop({ name: 'Hotel', type: 'lodging', location: { lat: 55.95, lng: -3.19 } }),
    ]);
    expect(tonightHotel([d], 0)!.name).toBe('Hotel');
  });
  it('looks back to a previous night when the day has none, but not forward', () => {
    const d0 = day([stop({ name: 'Hotel A', type: 'lodging', location: { lat: 55.95, lng: -3.19 } })]);
    const d1 = day([stop({ name: 'Day trip' })]);
    const d2 = day([stop({ name: 'Hotel B', type: 'lodging', location: { lat: 57, lng: -4 } })]);
    expect(tonightHotel([d0, d1, d2], 1)!.name).toBe('Hotel A'); // not Hotel B (future)
  });
  it('never mistakes a meal or activity for the hotel', () => {
    const d = day([stop({ name: 'Dinner', type: 'food' }), stop({ name: 'Walk', type: 'hike' })]);
    expect(tonightHotel([d], 0)).toBeNull();
  });
});

describe('dayConflicts', () => {
  it('flags an unreachable next stop', () => {
    const d = day([
      stop({ name: 'Lunch', startTime: '12:00PM', endTime: '12:45PM', location: { lat: 55.95, lng: -3.19 } }),
      stop({ name: 'Glenfinnan', startTime: '1:30PM', location: { lat: 56.8758, lng: -5.431 } }),
    ]);
    const c = dayConflicts(d);
    expect(c.length).toBe(1);
    expect(c[0]!.stopIndex).toBe(1);
  });
});
