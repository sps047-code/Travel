<script lang="ts">
  import { onMount } from 'svelte';
  import { createTripStore } from './lib/data/store';
  import type { Stop } from './lib/data/model';
  import { SEED_TRIP } from './lib/seed';
  import { nominatimGeocoder } from './lib/net/geocode';
  import { stopDuration, legBetween, tonightHotel, morningHotel, dayConflicts } from './lib/data/derive';
  import MapView from './components/MapView.svelte';
  import StopEditor from './components/StopEditor.svelte';

  const PERSIST_KEY = 'seasons2:scotland';

  function loadInitial() {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (raw) { try { return JSON.parse(raw); } catch { /* fall through */ } }
    }
    return SEED_TRIP;
  }

  const store = createTripStore(loadInitial(), { persistKey: PERSIST_KEY });

  let dayIdx = 0;
  let editing: Partial<Stop> | null = null;
  let editorOpen = false;
  let banner = '';

  $: trip = $store;
  $: day = trip.days[dayIdx];
  $: conflicts = day ? dayConflicts(day) : [];
  $: hotelTonight = day ? tonightHotel(trip.days, dayIdx) : null;
  $: hotelMorning = day ? morningHotel(trip.days, dayIdx) : null;

  function openAdd() { editing = null; editorOpen = true; }
  function openEdit(s: Stop) { editing = s; editorOpen = true; }

  function onSave(e: CustomEvent<Partial<Stop>>) {
    const data = e.detail;
    const res = data.id
      ? store.updateStop(data.id, data)
      : store.addStop(day!.id, { name: data.name!, type: data.type!, ...data });
    if (!res.ok) { banner = '⚠️ ' + res.errors.join(' '); return; }
    banner = '';
    editorOpen = false;
  }

  function del(s: Stop) { if (confirm(`Remove "${s.name}"?`)) store.deleteStop(s.id); }
  function move(s: Stop, dir: -1 | 1) { store.moveStop(s.id, dir); }
  function optimize() { if (day) store.optimizeDay(day.id); }

  onMount(async () => {
    // Self-heal locations from names in the background (no-op on the seed).
    try { await store.healLocations(nominatimGeocoder); } catch { /* offline */ }
  });
</script>

<header>
  <div class="brand">🍃 SEASONS <span class="ver">rebuild</span></div>
</header>

<nav class="tabs">
  {#each trip.days as d, i}
    <button class:active={i === dayIdx} on:click={() => (dayIdx = i)}>Day {i + 1}</button>
  {/each}
</nav>

{#if day}
  <MapView {day} days={trip.days} {dayIdx} />

  <main>
    <div class="dayhead">
      <div>
        <h2>Day {dayIdx + 1} — {day.title}</h2>
        <div class="sub">{day.date}{day.destination ? ' · ' + day.destination : ''}</div>
      </div>
      <div class="dayactions">
        <button class="ghost" on:click={optimize}>↔ Optimize order</button>
        <button class="primary" on:click={openAdd}>+ Add stop</button>
      </div>
    </div>

    {#if banner}<div class="err">{banner}</div>{/if}

    {#if hotelMorning}
      <div class="bookend">🏨 Starting from <b>{hotelMorning.name}</b></div>
    {/if}

    <ol class="timeline">
      {#each day.stops as s, i (s.id)}
        <li class="stop">
          <div class="time">
            {s.startTime ?? '—'}
            {#if stopDuration(s)}<span class="dur">⏱ {stopDuration(s)}</span>{/if}
          </div>
          <div class="body">
            <div class="name">
              {i + 1}. {s.name}
              <span class="badge b-{s.type}">{s.type}</span>
              {#if conflicts.find((c) => c.stopIndex === i)}
                <span class="warn" title={conflicts.find((c) => c.stopIndex === i)?.message}>⚠️</span>
              {/if}
            </div>
            {#if s.notes}<div class="notes">{s.notes}</div>{/if}
            <div class="controls">
              <button on:click={() => move(s, -1)} disabled={i === 0}>▲</button>
              <button on:click={() => move(s, 1)} disabled={i === day.stops.length - 1}>▼</button>
              <button on:click={() => openEdit(s)}>✎ Edit</button>
              <button on:click={() => del(s)}>✕</button>
            </div>
          </div>
        </li>
        {@const next = day.stops[i + 1]}
        {#if next}
          {@const leg = legBetween(s, next)}
          {#if leg}
            <li class="leg">
              ↓ {leg.miles < 10 ? leg.miles.toFixed(1) : Math.round(leg.miles)} mi ·
              {leg.minutes} min · {leg.mode}
              {#if leg.infeasibleEarliest}
                <span class="warn">⚠️ can't arrive before {leg.infeasibleEarliest}</span>
              {/if}
            </li>
          {/if}
        {/if}
      {/each}
    </ol>

    {#if hotelTonight}
      <div class="bookend">🏨 Tonight — <b>{hotelTonight.name}</b></div>
    {/if}
  </main>
{/if}

{#if editorOpen}
  <StopEditor stop={editing} on:save={onSave} on:cancel={() => (editorOpen = false)} />
{/if}

<style>
  header { background: var(--ink); color: var(--paper); padding: 12px 18px; }
  .brand { font-family: var(--font-display); font-size: 18px; letter-spacing: .04em; }
  .ver { font-size: 11px; color: #9fb3c8; margin-left: 6px; }
  .tabs { display: flex; gap: 4px; overflow-x: auto; background: var(--ink); padding: 0 12px 8px; }
  .tabs button { background: none; border: none; color: #9fb3c8; padding: 8px 12px; border-bottom: 2px solid transparent; white-space: nowrap; }
  .tabs button.active { color: #fff; border-color: var(--ruby); }
  main { max-width: 760px; margin: 0 auto; padding: 18px 16px 60px; }
  .dayhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
  h2 { margin: 0; font-size: 20px; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
  .dayactions { display: flex; gap: 8px; flex-shrink: 0; }
  .primary { background: var(--pine); color: #fff; border: none; padding: 8px 14px; border-radius: 8px; font-weight: 600; }
  .ghost { background: none; border: 1.5px solid var(--border); padding: 8px 12px; border-radius: 8px; }
  .err { background: rgba(194,59,59,.1); border: 1.5px solid var(--ruby); color: var(--ruby); padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
  .bookend { background: rgba(46,125,82,.08); border: 1.5px dashed rgba(46,125,82,.4); border-radius: 8px; padding: 10px 12px; font-size: 14px; margin: 8px 0; }
  .timeline { list-style: none; margin: 0; padding: 0; }
  .stop { display: flex; gap: 12px; background: var(--paper); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
  .time { min-width: 78px; font-size: 12px; font-weight: 600; color: var(--muted); display: flex; flex-direction: column; gap: 3px; }
  .dur { color: var(--ink-soft); }
  .body { flex: 1; min-width: 0; }
  .name { font-family: var(--font-display); font-size: 16px; }
  .badge { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; padding: 2px 7px; border-radius: 20px; background: var(--mist); color: var(--ink-soft); margin-left: 6px; }
  .b-lodging { background: rgba(46,125,82,.15); color: var(--pine); }
  .b-food { background: rgba(196,123,32,.15); color: var(--amber); }
  .notes { color: var(--ink-soft); font-size: 13px; margin-top: 4px; }
  .controls { display: flex; gap: 6px; margin-top: 8px; }
  .controls button { background: none; border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; font-size: 12px; }
  .controls button:disabled { opacity: .35; }
  .leg { list-style: none; color: var(--muted); font-size: 12px; padding: 6px 0 6px 90px; }
  .warn { color: var(--ruby); margin-left: 6px; font-weight: 600; }
</style>
