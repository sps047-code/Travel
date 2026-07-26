import { describe, it, expect } from 'vitest';
import {
  parseTimeMins, formatTimeMins, durationLabel, visitSpanMins, durationChip,
} from '../src/lib/core/time';

describe('parseTimeMins', () => {
  it('parses 12h and 24h clock strings', () => {
    expect(parseTimeMins('9:30 AM')).toBe(9 * 60 + 30);
    expect(parseTimeMins('12:08PM')).toBe(12 * 60 + 8);
    expect(parseTimeMins('12:00 AM')).toBe(0);
    expect(parseTimeMins('14:05')).toBe(14 * 60 + 5);
  });
  it('rejects durations/ranges so they never parse as a small-hours time', () => {
    expect(parseTimeMins('1h 30m')).toBeNull();
    expect(parseTimeMins('2-3pm')).toBeNull();
    expect(parseTimeMins('45min')).toBeNull();
    expect(parseTimeMins(null)).toBeNull();
  });
});

describe('formatTimeMins never wraps past midnight', () => {
  it('clamps rather than wrapping (the 2:26 AM bug class)', () => {
    expect(formatTimeMins(12 * 60 + 8)).toBe('12:08PM');
    expect(formatTimeMins(9 * 60)).toBe('9:00AM');
    // 25h would have wrapped to 1:00 AM under modulo — must clamp instead.
    expect(formatTimeMins(25 * 60)).toBe('11:59PM');
    expect(formatTimeMins(-30)).toBe('12:00AM');
  });
});

describe('duration is derived from the start/end pair', () => {
  it('12:08 -> 12:33 is 25min, not a stale stored value', () => {
    expect(durationChip('12:08PM', '12:33PM')).toBe('25min');
  });
  it('formats hours and minutes', () => {
    expect(durationLabel(45)).toBe('45min');
    expect(durationLabel(60)).toBe('1hr');
    expect(durationLabel(120)).toBe('2hrs');
    expect(durationLabel(90)).toBe('1h 30min');
    expect(durationChip('9:00AM', '11:30AM')).toBe('2h 30min');
  });
  it('returns null/empty when the span is not positive', () => {
    expect(visitSpanMins('2:00PM', '2:00PM')).toBeNull();
    expect(visitSpanMins('2:00PM', '1:00PM')).toBeNull();
    expect(durationChip(null, '1:00PM')).toBe('');
  });
});
