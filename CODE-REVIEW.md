# Seasons — reviewer's guide

A buildless vanilla-JS PWA for family travel itineraries. No framework, no
bundler; the files ship as-is to GitHub Pages.

Live: https://sps047-code.github.io/Travel/
Repo: https://github.com/sps047-code/travel (branch: `gh-pages`)

```
git clone https://github.com/sps047-code/travel && cd travel
node --test tests/*.test.mjs     # 47 tests, zero dependencies
```

## Files

| File | Lines | What it is |
|---|---|---|
| `trip.js` | 5274 | Everything: state, scheduling, rendering, sync, AI calls |
| `trip-extras.js` | 624 | Late-loaded patches that wrap `trip.js` functions |
| `trip.html` | 835 | Single page + the Add/Edit Stop modal |
| `index.html` | 1298 | Trip picker / home |
| `sw.js` | 137 | Service worker: caching + update strategy |
| `tests/live-core.test.mjs` | 672 | Loads real `trip.js` in a `vm` sandbox and drives it |
| `release.sh` | 59 | The only supported way to cut a release |

## Architecture, in one paragraph

`state` is a single global object (`{days:[{title, subtitle, stops:[...]}]}`)
persisted to `localStorage` and mirrored to a **public, unauthenticated**
Firebase Realtime Database for family sync. Every device polls
`/family/{tripId}/lastChange` every 3s and adopts `/state` when it changes.
`saveState()` is the only write path; it runs a "physical logic gate"
(`_logicErrors`) and refuses to persist an itinerary that adds a new
impossibility. Rendering is full-innerHTML re-render via `renderAll()`.

## Known weaknesses — please do challenge these

1. **No auth on the database.** The Firebase URL and config are in client
   source. Anyone who reads it can read/write the itinerary. This is the
   single biggest design flaw.
2. **`trip-extras.js` monkey-patches `trip.js`** (`window.saveStop = ...`),
   and a `MutationObserver` on `#content-area` re-runs work on DOM changes.
   Load-order and re-entrancy here are fragile.
3. **`trip.js` is one 5,274-line file** with no modules and heavy global
   state. Function-level cohesion is poor.
4. **Time was minutes-since-midnight with no date** until very recently.
   `_absMins`/`_stopStartAbs`/`_stopEndAbs` add real instants, but the
   *scheduling* engine (`_recalcDayTimes`, `_logicErrors` reachability)
   still largely reasons within a single day. **I consider this unfinished.**
5. **Two coordinate fields** (`lat/lng` and `destLat/destLng`) for transit
   stops; a known source of wrong distances.
6. **Last-writer-wins sync** with no merge. Simultaneous edits lose data.

## Incidents worth understanding (they shaped the code)

- **Data loss.** `_applyCoordHeal` and `_fixScotlandDay7Once` mutated the
  itinerary *on load* and pushed the result to the shared cloud, destroying
  weeks of user edits. Both are now hard no-ops. **Rule adopted: nothing
  automatic may rewrite a user's stops.** Check I have not reintroduced this.
- **Cache-first mislabelled network-first.** `sw.js` did
  `return cached || network` for navigations under a comment claiming
  network-first, so every HTML change needed two reloads and shipped fixes
  appeared not to exist.
- **Sync throttled by its own backups.** The 3s poll fetched the whole
  Firebase node, which included `/history` (5 full itinerary copies) —
  ~240 KB every 3 seconds. Now polls `/lastChange` only.
- **Ambiguous times.** A bare `"8:30"` parsed as 8:30 AM, so an 8:30 PM
  flight reported a 25h 30min duration. Inputs are now
  `<input type="time">` and one canonical format (`8:30 PM`) is enforced.

## Where I would look first

- `saveState` / `_syncFamily` / `_watchFamily` — the write and sync path.
- `_recalcDayTimes`, `moveStop`, `_setStopSlot` — the scheduling engine.
  Invariant intended: **a user-set time is data**; it may be pushed later
  when physically unreachable, never pulled earlier or invented. A `locked`
  stop must never be re-timed by anything automatic.
- `_logicErrors` — the objective feasibility rules (order, reachability,
  "Before arrival"). Only physical impossibility should fail, never taste.
- `_displayDuration` / `_endDateOf` / `_absMins` — date+time correctness.
- `renderAll` — must not mutate `state`. It used to, on every paint.

## Questions I would like answered

1. Is the single-day assumption in the scheduling engine actually safe now
   that stops can span dates? I suspect not.
2. Is the `_wouldLoseData` brake (>50% of stops lost blocks a push) the
   right guard, or is it both too weak and too surprising?
3. Is the `MutationObserver` in `trip-extras.js` re-entrant-safe?
4. Is there any remaining path where rendering or loading mutates `state`?
