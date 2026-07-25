# Seasons — Rebuild Requirements Specification

> **Status:** Draft v1 for your review. This is the contract for the from-scratch rebuild.
> Nothing gets built until you've read this and told me what's wrong or missing.
> Derived from a complete catalog of the existing app so no feature is lost.

---

## 0. What Seasons is

A family travel-itinerary Progressive Web App. Users create multi-day trips (by hand,
by AI, or by importing text/PDF), see each day as an ordered timeline of stops on a map,
and share a trip live with family. It works offline and installs to the home screen.

The rebuild keeps **what the app does** and replaces **how it stores and guards data**,
because every recurring bug traced back to the data layer — not the features.

---

## 1. Design principles (non-negotiable)

These exist because their absence caused the bugs. Every one is testable.

**P1 — One source of truth per fact.**
No fact may be stored in two fields that can disagree. The current app stores visit
length as *both* `duration` and `endTime`; a coordinate as *both* `lat/lng` and
`destLat/destLng`; a day's date only inside a free-text `subtitle`. All of these drifted.
The rebuild stores each fact once and *derives* everything else on read.

**P2 — Validate on write, never heal on read.**
Bad data must be rejected at the moment it is written, not saved and patched later.
The current app has ~17 `_heal*`/cap functions that repair corruption during rendering —
proof that corruption is being persisted. In the rebuild, a write that violates an
invariant fails loudly and is refused; the store can never hold invalid state.

**P3 — True self-healing location by name.**
A stop's location is derived from its **name** via geocoding, automatically. The user
must never need to know a place's coordinates, and must never be asked to press a "fix"
button. If a stored coordinate disagrees with what the name geocodes to, the geocode wins.

**P4 — Enforced ordering invariants.**
Stops within a day must be chronological **and** geographically sane (no absurd
back-and-forth). Violations are prevented on write; if one is ever detected, it is shown
as a visible error, not silently rendered.

**P5 — Tested core.**
The scheduling, travel-time, feasibility, and geocode-heal logic ship with an automated
test suite. The "moved-stop lands at 2 AM" and "20 mi to Glenfinnan" classes of bug must
be covered by tests that fail if the bug returns.

Supporting principles:

- **P6 — Offline-first.** The app is fully usable with no network, including a saved trip.
- **P7 — Safe sync.** Shared editing must not silently clobber another person's change,
  and no malformed remote write can corrupt a local trip.
- **P8 — No silent external failures made visible.** Every third-party call (geocoding,
  routing, AI, weather) degrades gracefully and, when it matters, tells the user.
- **P9 — Honest versioning.** One version string, shown in the header, that always
  reflects the running build.

---

## 2. Architecture requirements

**A1 — A single data-access layer (the "store").**
All reads and writes go through one module. There is exactly one in-memory copy of a
trip. No feature mutates trip data directly; it calls store methods that validate,
persist, and notify. This eliminates the current "`state` is replaced in 6 places, each
must remember to re-run every fix" problem.

**A2 — Schema-validated writes.**
Every trip/day/stop is validated against a schema (see §3) on every write. Invalid writes
are rejected with a specific error. Validation includes cross-field invariants (§5).

**A3 — Derived values are computed, never stored.**
End times, leg distances/durations, feasibility flags, "tonight's hotel", day-of-week,
and opening-hours status are all **computed** from the canonical fields at read time.
They are never persisted, so they can never drift.

**A4 — Structured dates.**
Each day has a real ISO date field (`date: "2026-06-06"`), not a date parsed out of prose.
Display strings are derived from it.

**A5 — Deterministic, mergeable sync.**
Sharing must not use blind whole-document last-writer-wins. Minimum bar: **field/stop-level
merge** so two people editing different stops don't overwrite each other, with a real
conflict resolution rule for the same field. (Options in §11 — your call.)

**A6 — Reactive rendering.**
The UI subscribes to the store. Any change re-renders the affected views — including the
map — from the single source. "The map didn't update when I deleted a stop" becomes
structurally impossible because there is one render path off one state.

---

## 3. Canonical data model

Fields marked **[canonical]** are stored; **[derived]** are computed and never persisted.

### Trip
```
id            [canonical]  stable unique id
title         [canonical]  trip name
startDate     [canonical]  ISO date of day 1
travelers[]   [canonical]  names
days[]        [canonical]  ordered
settings      [canonical]  { placesApiKey? }
prefs         [canonical]  { who, interests[], pace, budget } (from wizard)
```

### Day
```
id            [canonical]  stable id (for journal keys)
date          [canonical]  ISO date — REPLACES today's subtitle-embedded date
title         [canonical]  e.g. "Fly In & Zion"
destination   [canonical]  city/region label — REPLACES overloading the title
tip           [canonical]  pro-tip prose
stops[]       [canonical]  ordered, chronological+geographic invariant enforced
dayLabel      [derived]    "Day 3 — Fri Jun 5 • …"
weekday       [derived]    from date
```

### Stop
```
id            [canonical]  stable id — journal/guidebook keys bind here, survive reorder
name          [canonical]  the geocode key, AI target key, image key
type          [canonical]  one of: sight, food, lodging, hike, beach, shop, tour, show,
                           flight, train, bus, drive   (single enum; no type/mode overlap)
location      [canonical]  { lat, lng, geocodedFrom, verified } — ONE coordinate per stop.
                           geocodedFrom = the name string that produced it; verified =
                           user confirmed. destLat/destLng ELIMINATED.
startTime     [canonical]  ISO time-of-day, or null (untimed)
visitMinutes  [canonical]  integer minutes — THE single visit-length source.
                           "duration" string and "endTime" ELIMINATED as stored fields.
endTime       [derived]    startTime + visitMinutes
transitMode   [canonical]  only for transit stops: walk|drive|train|bus|flight
notes         [canonical]
reservation   [canonical]  confirmation #
stars         [canonical]
hours         [canonical]  { source: osm|google|user|ai, weekday map or day string }
                           ONE hours representation; "verified" derived from source.
media         [canonical]  { photo?, ticket?, ticketName? }
desc,guidebook[canonical]  AI prose
url,website,phone,audioUrl [canonical]
attendance[]  [canonical]  subset of travelers
isAlternate   [canonical]  excluded from routing/feasibility
autoArrival   [canonical]  machine-generated overnight-arrival marker (+ dismissal record)
```

Everything the old model computed on the fly — leg distance, leg time, feasibility,
"tonight's hotel", conflicts — is **[derived]** and lives in pure functions with tests.

---

## 4. Functional requirements (feature parity — nothing lost)

Each is a testable statement. Grouped by area. (Catalog-complete; ask if anything's missing.)

### 4.1 Home / trip list
- List local, built-in, and shared trips; hide/restore; delete.
- Create via **wizard** (destination, who, dates, day count, interests, pace, budget → AI plan).
- Create **blank** skeleton (geocoded destination, empty days).
- **Import** from pasted text or **PDF**, as a new trip or appended to an existing one.
- PWA install prompt. Header version badge (P9).

### 4.2 Itinerary display
- Day tabs (+ Overview), reorder days by drag or arrows, add/remove day, horizontal scroll.
- Stop cards: number, start time (+ timezone), **derived** end time, name, visit length,
  stars, notes, confirmation #, type badge, booked/to-book, weather warning, "up next".
- Leg connectors: **derived** distance + time + mode, timezone-change, and an inline
  **infeasibility warning** when the schedule can't fit the leg.
- Hotel bookends: "Starting from" (prev night), "Tonight" (overnight hotel), "End of Trip"
  (last day), or a transit bookend when arriving by flight/train.
- Swipe between days.

### 4.3 Stop CRUD
- Add/edit modal: name (+ live geocode search), type, date (routes to matching day),
  start time, visit length, stars, notes, reservation, transit from/to + airline/flight,
  url, audio url, alternate flag, photo upload, ticket upload (+ AI reservation OCR),
  AI description, transit mode, traveler attendance.
- Move up/down — **recalculates the whole day** (times + travel) keeping order valid (§5).
- Delete (remembering auto-arrival dismissals). Copy to another day (lodging→next-day origin).
- Day CRUD: add, remove, move, drag-reorder.

### 4.4 Timeline / scheduling
- Suggest next stop's start time. Recalculate a day's cascade (§7). Auto-sort chronological.
- Passive conflict detection: same-time, too-close, **impossible travel timing**,
  opening-hours (closed today / before open / near close). Shown as badges + overview dots.

### 4.5 Map
- Per-day map: driving route + flight arcs, start-hotel origin, drop coordinate outliers.
- Overview map: all stops, day-numbered pins.
- **The map always matches the itinerary** (P/A6) — updates on every add/edit/delete/move.

### 4.6 Hotel / "Tonight" logic
- Correct overnight lodging shown at day end. Never a meal or activity. Never a future
  day's hotel. Null on the last day (heading home). Distance/time/mode from last stop to hotel.

### 4.7 Opening hours
- Real hours by name-match (OpenStreetMap) → optional Google Places → AI estimate (labeled
  "est."). User override. Auto-load on day view. One representation (§3), status derived.

### 4.8 Ask AI (feasibility, plain language, protected)
- **Optimize Day**: feasibility judged on *can it be done* — open hours, mode, traffic,
  distance — **not pace**. Suggested order (apply w/ undo), timing fixes, cross-day moves.
- **Grade**, **Plan Chat** (conversational → structured change block → apply pipeline),
  location-aware **Tour Guide**.
- AI changes are **described in plain language**, never raw `add_stop`/`remove_stop`.
- Apply pipeline guarantees (hard rules): never edits coordinates; never invents lodging
  from an activity; never deletes the hotel; never uses an invalid type; never schedules a
  stop before it can physically be reached; leaves the day sorted and valid.
- Other AI: packing list, day briefing/narrative, stop description, guidebook, nearby notes,
  audio-tour discovery, restaurant alternates, ticket OCR.

### 4.9 Offline
- "Save Offline" (home + in-trip): persist state, app shell, stop images, and map tiles.
- Fully usable offline; online/offline indicator.

### 4.10 Sharing / sync
- Toggle solo↔family. Live presence. Safe merge sync (A5). No malformed remote write can
  corrupt a local trip.

### 4.11 Journal mode
- Auto-enable after the trip ends. Per-stop notes + "worth it" ratings, per-day memories,
  highlights, trip recap. Keyed to stable stop/day ids. **Synced** (fixing today's gap
  where journal data lives only on one device).

### 4.12 Weather, audio tours, checklist, packing, alternates, export, alerts
- Weather: historical / forecast / climate-average, inline warnings, live strip.
- Audio tours: built-in catalog + AI discovery, per-stop match, offline save.
- Checklist: auto bookables + custom, dismissible, stable done-state.
- Packing list (AI). Restaurant alternates. Excel export. Departure alerts. Read-only share link.

---

## 5. Enforced invariants (prevented on write; visible error if ever violated)

- **I1** Stops in a day are strictly chronological by start time.
- **I2** No stop is scheduled before the earliest time it can be reached from the previous
  stop (start_prev + visit_prev + travel). Violations → visible infeasibility error.
- **I3** No stop's start crosses midnight into the next day; a day fits real waking hours.
- **I4** Route ordering is geographically sane — flag/prevent absurd backtracking
  (e.g. Edinburgh → far-NW Highlands → back to central belt → back NW).
- **I5** A stop's coordinate must be consistent with its name's geocode within a tolerance,
  or it is corrected (P3) — never saved wrong.
- **I6** "Tonight's hotel" is a lodging stop, never a meal/activity, never a future day's.
- **I7** endTime = startTime + visitMinutes, always (derived, so unbreakable).
- **I8** Leg distance uses the stop's single coordinate (no second source).
- **I9** A remote/AI write that fails any invariant is rejected, not adopted.

---

## 6. Self-healing & geocoding (the Rosslyn requirement)

- **G1** A stop's coordinate is produced by geocoding its `name` (OpenStreetMap/Nominatim),
  not typed by the user and not looked up in a bundled file. Result cached by name.
- **G2** On load and on any name change, if the stored coordinate is more than a tolerance
  from the name's geocode, the geocode replaces it — automatically, no user action.
- **G3** Works for **any** place the user names, not just built-in trips.
- **G4** Ambiguous geocodes (multiple strong matches) are the only case that may ask the
  user to disambiguate — and only once; the choice is remembered.
- **G5** Geocoding is covered by tests using known landmarks (e.g. "Rosslyn Chapel" →
  55.855, −3.16) so a regression is caught before deploy.

---

## 7. Scheduling & travel model (ported, with tests)

- Distance: haversine (miles).
- Travel time by mode: flight ≈ miles/8; train, bus, walk factors; drive = miles × 1.25
  road factor, then adaptive mph (65/55/40/20 by distance band).
- Visit length = `visitMinutes` (single source), default by type when unset.
- Cascade: day anchor + Σ(visit + travel), each capped, never crossing midnight (I3).
- Feasibility: earliest arrival = prev departure + travel; flag when a start precedes it.
- **All of the above are pure functions with unit tests** (P5).

---

## 8. Non-functional

- **Performance:** home list and a trip render fast on a phone; heavy work (AI, tiles) async.
- **Security:** all user/AI/remote strings escaped on render (no stored XSS); URLs sanitized
  (block `javascript:`); remote state validated before adoption.
- **Offline:** service worker caches shell + saved trips + tiles; navigation works offline.
- **Accessibility:** buttons labeled; keyboard/Escape closes modals; adequate contrast.
- **Resilience:** every external dependency (geocode, routing, AI, weather, image) fails soft.

---

## 9. Failure modes this rebuild must make impossible

Mapped from the current app's known corruption classes → the rule that kills each.

| Old failure | Killed by |
|---|---|
| Moved stop lands at 1:30 / 2:26 AM (midnight wrap) | I3 + cascade caps + tests (P5) |
| Rosslyn Chapel coordinate drifts ~90 mi (wrong pin, "20 mi" leg) | G1–G3, I5 |
| `duration` vs `endTime` disagree | P1, I7 (endTime derived) |
| `lat/lng` vs `destLat/destLng` disagree | P1, I8 (one coordinate) |
| `dayHours` vs `openingHours` disagree | P1 (one hours field) |
| Date parsing breaks weather/journal/day-of-week | A4 (structured date) |
| Map doesn't update on delete | A6 (one reactive render path) |
| Out-of-chronological order after AI/sync | Validate-on-write (P2), I1 |
| Geographically nonsensical route | I4 |
| Family last-writer clobber | A5 (merge sync) |
| Malformed remote write wipes itinerary | I9 + validation |
| Journal notes desync across devices | 4.11 (synced, id-keyed) |
| "Which version am I on?" ambiguity | P9 (one version string) |
| Heal-on-read masking persisted corruption | P2 (no persisted corruption to heal) |

---

## 10. Tech stack (recommendation — your call)

- **Frontend:** small reactive framework (or a tiny signals layer) so the store→UI binding
  of A6 is clean. Keep it a static PWA (no server to run), deployable to GitHub Pages.
- **Data layer:** typed schema (e.g. Zod-style validators) enforcing §3/§5 on every write.
- **Sync (A5):** the honest options —
  1. Keep Firebase but move to **RTDB with security rules + field-level writes** and a
     merge/conflict rule (moderate effort, no server).
  2. Move to **Firestore** (document/field merges, offline SDK) — better sync, still no server.
  3. A **CRDT** (e.g. Yjs) for true conflict-free multi-editor — best UX, more to learn.
  I recommend starting at option 1/2; CRDT only if live co-editing matters.
- **Tests:** a unit runner for the scheduling/geocode/invariant functions (P5, G5, §7).
- **Map:** Leaflet + OSM (unchanged). **Geocode:** Nominatim. **Routing:** OSRM. **AI:** existing proxy.

---

## 11. Migration

- Import existing trips (localStorage + Firebase) through a **one-time upcaster** that maps
  old fields → new canonical model: collapse `duration`/`endTime` → `visitMinutes`; collapse
  `lat/lng`+`destLat/destLng` → one `location` (re-geocoding from name where they disagree);
  parse `subtitle` date → `date`; collapse hours fields. Anything failing validation is
  reported, not silently dropped.

---

## 12. Open questions for you

1. **Sync:** live co-editing (two phones at once) important, or is "sync within a few
   seconds, rare simultaneous edits" fine? This decides option 1/2 vs CRDT in §10.
2. **Geographic ordering (I4):** should the app *auto-reorder* a nonsensical route, or
   *flag* it and let you fix it? (I lean flag-by-default, one-tap accept.)
3. **Scope of first release:** full parity before you switch over, or a core (create/view/
   edit/map/geocode-heal) first, then port the rest (journal, audio, weather, alerts)?
4. **Stack:** any preference, or trust my recommendation in §10?
5. Anything in §4 that's wrong, missing, or that you don't actually use and want dropped?
