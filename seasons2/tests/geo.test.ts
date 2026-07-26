import { describe, it, expect } from 'vitest';
import {
  haversine, isValidPoint, travelMins, coordHasDrifted,
} from '../src/lib/core/geo';

const ROSSLYN = { lat: 55.8553, lng: -3.16 };
const GLENFINNAN = { lat: 56.8758, lng: -5.431 };
const GLENCOE = { lat: 56.6779, lng: -5.0974 };

describe('haversine', () => {
  it('Rosslyn -> Glenfinnan is ~112 mi (the correct leg, not 20)', () => {
    const d = haversine(ROSSLYN.lat, ROSSLYN.lng, GLENFINNAN.lat, GLENFINNAN.lng);
    expect(Math.round(d)).toBeGreaterThan(100);
    expect(Math.round(d)).toBeLessThan(125);
  });
  it('Glencoe -> Glenfinnan is ~19 mi (what the corrupt coord produced)', () => {
    const d = haversine(GLENCOE.lat, GLENCOE.lng, GLENFINNAN.lat, GLENFINNAN.lng);
    expect(Math.round(d)).toBeLessThan(25);
  });
});

describe('isValidPoint', () => {
  it('treats 0,0 and out-of-range as unusable', () => {
    expect(isValidPoint({ lat: 0, lng: 0 })).toBe(false);
    expect(isValidPoint({ lat: 99, lng: 0 })).toBe(false);
    expect(isValidPoint(null)).toBe(false);
    expect(isValidPoint(ROSSLYN)).toBe(true);
  });
});

describe('travelMins', () => {
  it('~20mi drive is ~35-40 min (matches the on-screen 38 min)', () => {
    const t = travelMins(18.6, 'drive');
    expect(t).toBeGreaterThan(30);
    expect(t).toBeLessThan(45);
  });
});

describe('coordHasDrifted (self-heal trigger)', () => {
  it('flags the Rosslyn->Glencoe corruption (~90mi)', () => {
    expect(coordHasDrifted(GLENCOE, ROSSLYN)).toBe(true);
  });
  it('does not flag a small deliberate pin nudge', () => {
    expect(coordHasDrifted({ lat: 55.86, lng: -3.17 }, ROSSLYN)).toBe(false);
  });
});
