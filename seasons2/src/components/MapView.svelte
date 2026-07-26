<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import type { Day, Stop } from '../lib/data/model';
  import { isValidPoint } from '../lib/core/geo';
  import { routableStops, morningHotel, tonightHotel } from '../lib/data/derive';

  export let day: Day;
  export let days: Day[] = [];
  export let dayIdx = 0;

  let el: HTMLDivElement;
  let map: L.Map | null = null;
  let markers = L.layerGroup();
  let routes = L.layerGroup();

  const TYPE_COLOR: Record<string, string> = {
    sight: '#c23b3b', hike: '#c23b3b', beach: '#c23b3b',
    food: '#c47b20', shop: '#c47b20', tour: '#c47b20', show: '#c47b20',
    lodging: '#2e7d52', drive: '#2b6cb0', flight: '#7b5ea7', train: '#4a6572', bus: '#1d4e73',
  };

  function pin(num: number, color: string): L.DivIcon {
    return L.divIcon({
      className: '',
      iconSize: [26, 32], iconAnchor: [13, 32],
      html: `<svg width="26" height="32" viewBox="0 0 30 36"><path d="M15 0C7.3 0 1 6.3 1 14c0 8.8 14 22 14 22s14-13.2 14-22C29 6.3 22.7 0 15 0z" fill="${color}" stroke="white" stroke-width="1.5"/><text x="15" y="17" text-anchor="middle" fill="white" font-size="12" font-weight="800" font-family="sans-serif">${num}</text></svg>`,
    });
  }
  function hotelIcon(): L.DivIcon {
    return L.divIcon({
      className: '', iconSize: [26, 26], iconAnchor: [13, 13],
      html: `<div style="background:#2e7d52;color:#fff;border:2px solid #fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4)">🏨</div>`,
    });
  }

  function redraw(): void {
    if (!map) return;
    markers.clearLayers();
    routes.clearLayers();
    const bounds: L.LatLngExpression[] = [];

    const start = morningHotel(days, dayIdx);
    const end = tonightHotel(days, dayIdx);

    day.stops.forEach((s: Stop, i: number) => {
      if (!isValidPoint(s.location)) return;
      const m = L.marker([s.location.lat, s.location.lng], {
        icon: pin(i + 1, TYPE_COLOR[s.type] ?? '#8b7355'),
      }).bindPopup(`<b>${s.name}</b>`);
      markers.addLayer(m);
      bounds.push([s.location.lat, s.location.lng]);
    });

    // Route: morning hotel -> routable stops -> tonight's hotel (always a line).
    const path: L.LatLngExpression[] = [];
    if (start && isValidPoint(start.location)) { path.push([start.location.lat, start.location.lng]); bounds.push(path[0]!); }
    for (const s of routableStops(day)) path.push([s.location!.lat, s.location!.lng]);
    if (end && isValidPoint(end.location)) { const p: L.LatLngExpression = [end.location.lat, end.location.lng]; path.push(p); bounds.push(p); }
    if (path.length > 1) routes.addLayer(L.polyline(path, { color: '#c1512d', weight: 3, opacity: 0.7 }));

    if (start && isValidPoint(start.location)) markers.addLayer(L.marker([start.location.lat, start.location.lng], { icon: hotelIcon() }).bindPopup(`Start: ${start.name}`));
    if (end && isValidPoint(end.location) && !(start && end.location.lat === start.location?.lat && end.location.lng === start.location?.lng))
      markers.addLayer(L.marker([end.location.lat, end.location.lng], { icon: hotelIcon() }).bindPopup(`Tonight: ${end.name}`));

    if (bounds.length) map.fitBounds(bounds as L.LatLngBoundsExpression, { padding: [40, 40] });
  }

  onMount(() => {
    map = L.map(el, { zoomControl: true }).setView([56.5, -4.2], 7);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 19,
    }).addTo(map);
    markers.addTo(map);
    routes.addTo(map);
    redraw();
  });
  onDestroy(() => { map?.remove(); map = null; });

  // Re-render whenever the day or its stops change — the map can't drift (A6).
  $: if (map && day) redraw();
</script>

<div class="map" bind:this={el}></div>

<style>
  .map { height: 300px; width: 100%; background: #dfe6ea; }
</style>
