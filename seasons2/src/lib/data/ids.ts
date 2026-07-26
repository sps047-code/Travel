// Stable id generation. Journal/guidebook data binds to these, so they must be
// unique and never reused. Prefix marks the kind (t/d/s).

let counter = 0;

export function genId(prefix: 't' | 'd' | 's'): string {
  counter += 1;
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}${counter.toString(36)}${rand}`;
}
