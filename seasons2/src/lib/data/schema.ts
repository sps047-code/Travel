// ============================================================================
// Schema — validate on WRITE (REQUIREMENTS §1 P2, §2 A2). Every trip/day/stop
// that enters the store passes through here; invalid data is rejected, never
// stored and patched later. Zod is the single validator.
// ============================================================================

import { z } from 'zod';
import { STOP_TYPES, TRANSIT_MODES } from './model';
import type { Trip } from './model';

const clockTime = z
  .string()
  .regex(/^\d{1,2}:\d{2}\s*(AM|PM)?$/i, 'expected a clock time like "9:30 AM"');

const geoPoint = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  geocodedFrom: z.string().optional(),
  verified: z.boolean().optional(),
});

const hours = z.object({
  source: z.enum(['osm', 'google', 'user', 'ai']),
  today: z.string().optional(),
  week: z.array(z.string()).optional(),
});

export const stopSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1, 'a stop needs a name'),
    type: z.enum(STOP_TYPES),
    location: geoPoint.nullable(),
    startTime: clockTime.nullable(),
    endTime: clockTime.nullable(),
    transitMode: z.enum(TRANSIT_MODES).optional(),
    notes: z.string().optional(),
    reservation: z.string().optional(),
    stars: z.string().optional(),
    hours: hours.optional(),
    media: z
      .object({
        photo: z.string().optional(),
        ticket: z.string().optional(),
        ticketName: z.string().optional(),
      })
      .optional(),
    desc: z.string().optional(),
    guidebook: z.string().optional(),
    url: z.string().optional(),
    website: z.string().optional(),
    phone: z.string().optional(),
    audioUrl: z.string().optional(),
    attendance: z.array(z.string()).optional(),
    isAlternate: z.boolean().optional(),
    autoArrival: z.boolean().optional(),
  })
  // Invariant: a 0,0 coordinate is "unknown", never a real location.
  .refine((s) => !(s.location && s.location.lat === 0 && s.location.lng === 0), {
    message: '0,0 is not a real location (use null for unknown)',
    path: ['location'],
  })
  // Invariant I7: if both times exist, end must be after start.
  .refine(
    (s) => {
      if (!s.startTime || !s.endTime) return true;
      const p = (t: string) => {
        const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?/i);
        if (!m) return NaN;
        let h = +m[1]!;
        const ap = (m[3] || '').toLowerCase();
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return h * 60 + +m[2]!;
      };
      return p(s.endTime) > p(s.startTime);
    },
    { message: 'end time must be after start time', path: ['endTime'] },
  );

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected ISO date YYYY-MM-DD');

export const daySchema = z.object({
  id: z.string().min(1),
  date: isoDate,
  title: z.string(),
  destination: z.string().optional(),
  tip: z.string().optional(),
  stops: z.array(stopSchema),
});

export const tripSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  startDate: isoDate,
  tripType: z.enum(['solo', 'family']),
  travelers: z.array(z.string()),
  days: z.array(daySchema),
  settings: z.object({ placesApiKey: z.string().optional() }).optional(),
  prefs: z
    .object({
      who: z.string().optional(),
      interests: z.array(z.string()).optional(),
      pace: z.string().optional(),
      budget: z
        .object({ total: z.number().optional(), perDay: z.number().optional() })
        .optional(),
    })
    .optional(),
});

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

function toResult<T>(parsed: z.SafeParseReturnType<unknown, T>): ValidationResult<T> {
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    ),
  };
}

export function validateStop(input: unknown): ValidationResult<import('./model').Stop> {
  return toResult(stopSchema.safeParse(input)) as ValidationResult<import('./model').Stop>;
}

export function validateTrip(input: unknown): ValidationResult<Trip> {
  return toResult(tripSchema.safeParse(input)) as ValidationResult<Trip>;
}

/** True only when the value is structurally a trip (used to guard remote/cloud
 *  adoption — a malformed push must never overwrite a good local trip, I9). */
export function isValidTripShape(input: unknown): input is Trip {
  return tripSchema.safeParse(input).success;
}
