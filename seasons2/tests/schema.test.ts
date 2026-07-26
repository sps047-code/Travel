import { describe, it, expect } from 'vitest';
import { validateStop, validateTrip, isValidTripShape } from '../src/lib/data/schema';

const goodStop = {
  id: 's1', name: 'Rosslyn Chapel', type: 'sight',
  location: { lat: 55.8553, lng: -3.16 },
  startTime: '9:30 AM', endTime: '10:30 AM',
};

describe('validateStop rejects invalid data on write (P2)', () => {
  it('accepts a well-formed stop', () => {
    expect(validateStop(goodStop).ok).toBe(true);
  });
  it('rejects an end time before the start (I7)', () => {
    const r = validateStop({ ...goodStop, endTime: '9:00 AM' });
    expect(r.ok).toBe(false);
  });
  it('rejects a 0,0 location', () => {
    const r = validateStop({ ...goodStop, location: { lat: 0, lng: 0 } });
    expect(r.ok).toBe(false);
  });
  it('rejects an unknown type', () => {
    const r = validateStop({ ...goodStop, type: 'lodge' });
    expect(r.ok).toBe(false);
  });
  it('rejects an out-of-range coordinate', () => {
    const r = validateStop({ ...goodStop, location: { lat: 999, lng: -3 } });
    expect(r.ok).toBe(false);
  });
  it('rejects a nameless stop', () => {
    const r = validateStop({ ...goodStop, name: '' });
    expect(r.ok).toBe(false);
  });
});

const goodTrip = {
  id: 't1', title: 'Scotland', startDate: '2026-08-04',
  tripType: 'family', travelers: ['London', 'Bella'],
  days: [{ id: 'd1', date: '2026-08-10', title: 'Highlands', stops: [goodStop] }],
};

describe('validateTrip / isValidTripShape', () => {
  it('accepts a well-formed trip', () => {
    expect(validateTrip(goodTrip).ok).toBe(true);
    expect(isValidTripShape(goodTrip)).toBe(true);
  });
  it('rejects a non-ISO date (no more subtitle-parsed dates)', () => {
    expect(validateTrip({ ...goodTrip, startDate: 'Aug 4 2026' }).ok).toBe(false);
  });
  it('rejects a malformed remote push (guards cloud adoption, I9)', () => {
    expect(isValidTripShape({ nonsense: true })).toBe(false);
    expect(isValidTripShape(null)).toBe(false);
  });
});
