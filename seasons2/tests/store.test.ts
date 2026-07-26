import { describe, it, expect } from 'vitest';
import { createTripStore, newTrip, newDay, type Geocoder } from '../src/lib/data/store';
import type { Trip, GeoPoint } from '../src/lib/data/model';

function baseTrip(): Trip {
  const t = newTrip('Scotland', '2026-08-04');
  t.tripType = 'family';
  const d = newDay('2026-08-10', 'Highlands');
  d.id = 'd1';
  t.days.push(d);
  return t;
}

describe('store validate-on-write', () => {
  it('adds a valid stop and re-renders subscribers', () => {
    const s = createTripStore(baseTrip());
    let latest: Trip | null = null;
    s.subscribe((t) => (latest = t));
    const r = s.addStop('d1', {
      name: 'Rosslyn Chapel', type: 'sight',
      location: { lat: 55.8553, lng: -3.16 }, startTime: '9:30AM', endTime: '10:30AM',
    });
    expect(r.ok).toBe(true);
    expect(latest!.days[0]!.stops).toHaveLength(1);
    expect(latest!.days[0]!.stops[0]!.id).toMatch(/^s/);
  });

  it('REFUSES an update that would violate an invariant, leaving the store unchanged', () => {
    const s = createTripStore(baseTrip());
    s.addStop('d1', { name: 'A', type: 'sight', location: { lat: 55.9, lng: -3.1 },
      startTime: '9:00AM', endTime: '10:00AM' });
    const id = s.get().days[0]!.stops[0]!.id;
    const before = JSON.stringify(s.get());
    const r = s.updateStop(id, { endTime: '8:00AM' }); // end before start
    expect(r.ok).toBe(false);
    expect(JSON.stringify(s.get())).toBe(before); // unchanged
  });

  it('refuses a 0,0 location', () => {
    const s = createTripStore(baseTrip());
    const r = s.addStop('d1', { name: 'Nowhere', type: 'sight', location: { lat: 0, lng: 0 } });
    expect(r.ok).toBe(false);
  });

  it('refuses adopting a malformed cloud push (I9)', () => {
    const s = createTripStore(baseTrip());
    expect(s.setTrip({ garbage: true }).ok).toBe(false);
    expect(s.setTrip(null).ok).toBe(false);
    expect(s.get().days).toHaveLength(1); // still the good local trip
  });

  it('deleteStop removes and keeps the day valid', () => {
    const s = createTripStore(baseTrip());
    s.addStop('d1', { name: 'A', type: 'sight', location: { lat: 55.9, lng: -3.1 } });
    const id = s.get().days[0]!.stops[0]!.id;
    expect(s.deleteStop(id).ok).toBe(true);
    expect(s.get().days[0]!.stops).toHaveLength(0);
  });
});

describe('location self-heal by name', () => {
  const geocoder: Geocoder = {
    async geocode(name: string): Promise<GeoPoint | null> {
      if (/rosslyn/i.test(name)) return { lat: 55.8553, lng: -3.16 };
      return null;
    },
  };

  it('replaces a coordinate that has drifted far from the name geocode', async () => {
    const s = createTripStore(baseTrip());
    // Rosslyn stored at Glencoe (~90mi off) — the corruption bug.
    s.addStop('d1', { name: 'Rosslyn Chapel', type: 'sight',
      location: { lat: 56.6779, lng: -5.0974 } });
    const healed = await s.healLocations(geocoder);
    expect(healed).toBe(1);
    const loc = s.get().days[0]!.stops[0]!.location!;
    expect(Math.round(loc.lat * 10) / 10).toBe(55.9);
  });

  it('does not touch a user-verified pin', async () => {
    const s = createTripStore(baseTrip());
    s.addStop('d1', { name: 'Rosslyn Chapel', type: 'sight',
      location: { lat: 56.6779, lng: -5.0974, verified: true } });
    const healed = await s.healLocations(geocoder);
    expect(healed).toBe(0);
  });
});
