// ============================================================================
// Time — pure, tested. Clock strings <-> minutes-since-midnight, and the
// DERIVED duration (REQUIREMENTS §1 P1 / I7 / §7). No timezone math here; a
// stop's times are in its own day's local sense.
// ============================================================================

/** Parse "9:30 AM" / "9:30AM" / "14:05" -> minutes since midnight, else null.
 *  Anchored so durations/ranges ("1h 30m", "2-3pm") do NOT parse as a time. */
export function parseTimeMins(t: string | null | undefined): number | null {
  if (t == null) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const ap = (m[3] || '').toLowerCase();
  if (h > 23 || mi > 59) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + mi;
}

/** Minutes since midnight -> "9:30AM". Clamped to a single day (never wraps). */
export function formatTimeMins(mins: number): string {
  const x = Math.max(0, Math.min(24 * 60 - 1, Math.round(mins)));
  let h = Math.floor(x / 60);
  const mi = x % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(mi).padStart(2, '0')}${ap}`;
}

/** Human duration label from a minute count: 45->"45min", 60->"1hr",
 *  90->"1h 30min", 120->"2hrs". */
export function durationLabel(mins: number): string {
  const m0 = Math.max(0, Math.round(mins));
  const h = Math.floor(m0 / 60);
  const m = m0 % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}${h === 1 ? 'hr' : 'hrs'}`;
  return `${h}h ${m}min`;
}

/** The DERIVED visit length in minutes from a start/end pair, or null when the
 *  pair can't define one. This is the single source of truth for how long a
 *  stop lasts — there is no stored duration to disagree with it. */
export function visitSpanMins(
  startTime: string | null,
  endTime: string | null,
): number | null {
  const s = parseTimeMins(startTime);
  const e = parseTimeMins(endTime);
  if (s == null || e == null) return null;
  const span = e - s;
  return span > 0 ? span : null;
}

/** The duration chip a stop should show, derived from its times. Empty string
 *  when the stop has no usable span (so nothing is rendered). */
export function durationChip(
  startTime: string | null,
  endTime: string | null,
): string {
  const span = visitSpanMins(startTime, endTime);
  return span == null ? '' : durationLabel(span);
}
