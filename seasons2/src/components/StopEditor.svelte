<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Stop, StopType, GeoPoint } from '../lib/data/model';
  import { STOP_TYPES } from '../lib/data/model';
  import { durationChip } from '../lib/core/time';
  import { searchPlaces, type GeoResult } from '../lib/net/geocode';

  export let stop: Partial<Stop> | null = null; // null = adding

  const dispatch = createEventDispatcher<{ save: Partial<Stop>; cancel: void }>();

  let name = stop?.name ?? '';
  let type: StopType = stop?.type ?? 'sight';
  let startTime = stop?.startTime ?? '';
  let endTime = stop?.endTime ?? '';
  let notes = stop?.notes ?? '';
  let location: GeoPoint | null = stop?.location ?? null;

  let results: GeoResult[] = [];
  let searching = false;
  let errors: string[] = [];

  $: derivedDuration = durationChip(startTime || null, endTime || null);

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function onNameInput(): void {
    clearTimeout(searchTimer);
    const q = name;
    searchTimer = setTimeout(async () => {
      if (q.trim().length < 3) { results = []; return; }
      searching = true;
      try { results = await searchPlaces(q); } catch { results = []; }
      searching = false;
    }, 500);
  }
  function pick(r: GeoResult): void {
    location = { ...r.point, geocodedFrom: name, verified: true };
    results = [];
  }

  function save(): void {
    errors = [];
    if (!name.trim()) { errors = ['A stop needs a name.']; return; }
    dispatch('save', {
      ...(stop?.id ? { id: stop.id } : {}),
      name: name.trim(),
      type,
      startTime: startTime.trim() || null,
      endTime: endTime.trim() || null,
      notes: notes.trim() || undefined,
      location,
    });
  }
</script>

<svelte:window on:keydown={(e) => e.key === 'Escape' && dispatch('cancel')} />
<div class="overlay" role="presentation" on:click|self={() => dispatch('cancel')}>
  <div class="modal" role="dialog" aria-modal="true">
    <h3>{stop?.id ? 'Edit stop' : 'Add a stop'}</h3>

    <label>Name
      <input bind:value={name} on:input={onNameInput} placeholder="e.g. Rosslyn Chapel" />
    </label>
    {#if searching}<div class="hint">Searching…</div>{/if}
    {#if results.length}
      <ul class="results">
        {#each results as r}
          <li><button type="button" on:click={() => pick(r)}>{r.label}</button></li>
        {/each}
      </ul>
    {/if}
    {#if location}<div class="hint">📍 {location.lat.toFixed(4)}, {location.lng.toFixed(4)}</div>{/if}

    <label>Type
      <select bind:value={type}>
        {#each STOP_TYPES as t}<option value={t}>{t}</option>{/each}
      </select>
    </label>

    <div class="row">
      <label>Start<input bind:value={startTime} placeholder="9:30 AM" /></label>
      <label>End<input bind:value={endTime} placeholder="10:30 AM" /></label>
    </div>
    <div class="hint">Duration (calculated): {derivedDuration || '—'}</div>

    <label>Notes<textarea bind:value={notes} rows="2"></textarea></label>

    {#if errors.length}<div class="err">{errors.join(' ')}</div>{/if}

    <div class="actions">
      <button class="ghost" on:click={() => dispatch('cancel')}>Cancel</button>
      <button class="primary" on:click={save}>{stop?.id ? 'Save' : 'Add'}</button>
    </div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(26,35,50,.5); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 1000; }
  .modal { background: var(--paper); border-radius: var(--radius); padding: 20px; width: 100%; max-width: 440px; max-height: 90vh; overflow-y: auto; box-shadow: 0 8px 40px rgba(26,35,50,.3); }
  h3 { margin: 0 0 12px; }
  label { display: block; font-size: 12px; font-weight: 600; color: var(--ink-soft); margin-bottom: 10px; }
  input, select, textarea { display: block; width: 100%; margin-top: 4px; padding: 9px 10px; border: 1.5px solid var(--border); border-radius: 8px; font: inherit; background: var(--paper); }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .hint { font-size: 12px; color: var(--muted); margin: -4px 0 10px; }
  .err { color: var(--ruby); font-size: 13px; margin-bottom: 10px; }
  .results { list-style: none; margin: -4px 0 10px; padding: 0; border: 1px solid var(--border); border-radius: 8px; max-height: 160px; overflow-y: auto; }
  .results button { display: block; width: 100%; text-align: left; padding: 8px 10px; border: none; background: none; font-size: 12px; border-bottom: 1px solid var(--border); }
  .results button:hover { background: var(--mist); }
  .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
  .primary { background: var(--pine); color: #fff; border: none; padding: 9px 18px; border-radius: 8px; font-weight: 600; }
  .ghost { background: none; border: 1.5px solid var(--border); padding: 9px 16px; border-radius: 8px; }
</style>
