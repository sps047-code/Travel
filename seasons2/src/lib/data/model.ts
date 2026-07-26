// ============================================================================
// Canonical data model — REQUIREMENTS §3 (with the v121 decisions baked in).
//
// Principles enforced by the TYPES here (validation enforces the rest, schema.ts):
//  - One source of truth per fact. Visit length is the (startTime, endTime) pair;
//    `duration` is NEVER stored — it is derived (core/time.ts:durationLabel).
//  - One coordinate per stop (`location`); no destLat/destLng second source.
//  - Structured ISO date on the Day; never parsed out of prose.
//  - Stable ids on Trip/Day/Stop so journal/guidebook data binds across reorders.
// ============================================================================

export const STOP_TYPES = [
  'sight', 'food', 'lodging', 'hike', 'beach', 'shop', 'tour', 'show',
  'flight', 'train', 'bus', 'drive',
] as const;
export type StopType = (typeof STOP_TYPES)[number];

export const TRANSIT_TYPES = ['flight', 'train', 'bus'] as const;
export type TransitType = (typeof TRANSIT_TYPES)[number];

export const TRANSIT_MODES = ['walk', 'drive', 'train', 'bus', 'flight'] as const;
export type TransitMode = (typeof TRANSIT_MODES)[number];

/** WGS84 coordinate plus provenance. The ONLY location a stop has. */
export interface GeoPoint {
  lat: number;
  lng: number;
  /** The name string that produced this coordinate (for self-heal, §6/G1). */
  geocodedFrom?: string;
  /** True once the user has confirmed/placed the pin explicitly. */
  verified?: boolean;
}

export type HoursSource = 'osm' | 'google' | 'user' | 'ai';
export interface Hours {
  source: HoursSource;
  /** Hours for the specific weekday, e.g. "9:00 AM - 5:00 PM" or "Closed". */
  today?: string;
  /** Optional full-week strings (Google weekday_text style). */
  week?: string[];
}

export interface StopMedia {
  photo?: string; // data URL or http URL
  ticket?: string; // data URL / base64
  ticketName?: string;
}

/**
 * A single stop. Times are clock strings in the day's local sense ("9:30 AM").
 * startTime/endTime are CANONICAL; duration is derived and never stored.
 */
export interface Stop {
  id: string; // stable
  name: string; // geocode key, AI target key, image key
  type: StopType;
  location: GeoPoint | null; // null = not yet located
  startTime: string | null; // clock time, or null (untimed)
  endTime: string | null; // clock time; with startTime defines the visit span
  transitMode?: TransitMode; // only meaningful for transit stops
  notes?: string;
  reservation?: string;
  stars?: string;
  hours?: Hours;
  media?: StopMedia;
  desc?: string;
  guidebook?: string;
  url?: string;
  website?: string;
  phone?: string;
  audioUrl?: string;
  attendance?: string[]; // subset of trip.travelers
  isAlternate?: boolean; // excluded from routing/feasibility
  autoArrival?: boolean; // machine-generated overnight-arrival marker
}

export interface Day {
  id: string; // stable (journal keys)
  date: string; // ISO "YYYY-MM-DD" — replaces subtitle-embedded date
  title: string; // e.g. "Fly In & Zion"
  destination?: string; // city/region label
  tip?: string;
  stops: Stop[];
}

export type TripType = 'solo' | 'family';

export interface TripPrefs {
  who?: string;
  interests?: string[];
  pace?: string;
  budget?: { total?: number; perDay?: number };
}

export interface Trip {
  id: string;
  title: string;
  startDate: string; // ISO "YYYY-MM-DD" of day 1
  tripType: TripType;
  travelers: string[];
  days: Day[];
  settings?: { placesApiKey?: string };
  prefs?: TripPrefs;
}

export function isTransit(type: StopType): type is TransitType {
  return (TRANSIT_TYPES as readonly string[]).includes(type);
}
