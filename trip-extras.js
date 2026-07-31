// trip-extras.js — end time, timezone labels, AI-itinerary edits with confirmation,
//                   overnight arrivals, connector distance fix, end-of-trip label, audio URLs
//
// IMPORTANT: This is a classic <script> loaded after trip.js. It shares the
// global lexical scope, so trip.js's top-level `let` bindings (state,
// _pcHistory, editingStop, addingToDay, currentDayIdx) and its function
// declarations (saveState, renderAll, stopTz, callClaude, _pcAddMessage,
// haversine, _travelMins, _minsToStr, etc.) are referenced HERE BY BARE NAME
// — NOT via window.X. `let`/`const` globals are NOT attached to window.
(function(){
'use strict';

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── 1.  INJECT END-TIME + AUDIO-URL FIELDS INTO ADD/EDIT MODAL ───────────────
function _injectFormField(){
  const timeGrp = document.querySelector('#f-time')?.closest('.form-group');
  if(timeGrp && !document.getElementById('f-endtime')){
    const g = document.createElement('div');
    g.className = 'form-group';
    g.innerHTML = '<label class="form-label">End Time</label><input type="text" class="form-input" id="f-endtime" placeholder="e.g. 11:00 AM"/>';
    timeGrp.after(g);
  }
  const notesGrp = document.querySelector('#f-notes')?.closest('.form-group');
  if(notesGrp && !document.getElementById('f-audiourl')){
    const g = document.createElement('div');
    g.className = 'form-group';
    g.innerHTML = '<label class="form-label">Audio Tour URL</label><input type="text" class="form-input" id="f-audiourl" placeholder="e.g. https://podcasts.ricksteves.com/audio-tours/..."/>';
    notesGrp.before(g);
  }
}

// ── 2.  PATCH saveStop TO CAPTURE endTime + audioUrl ───────────────────────
// End Time + Audio URL are now read directly inside trip.js saveStop (so they
// attach to the correct stop before the day is sorted, and repaint immediately).
// This wrapper only needs to re-derive overnight-arrival stops afterwards.
const _origSaveStop = window.saveStop;
window.saveStop = function(){
  _origSaveStop.apply(this, arguments);
  if(_syncOvernightArrivals()){ try{saveState('',true);}catch(e){} try{renderAll();}catch(e){} }
};

// ── 3.  PATCH openEditStopModal TO PRE-FILL endTime + audioUrl ───────────────
const _origOpenEdit = window.openEditStopModal;
window.openEditStopModal = function(dayIdx, stopIdx){
  _origOpenEdit.apply(this, arguments);
  try{
    const s = state.days[dayIdx].stops[stopIdx];
    const el = document.getElementById('f-endtime');
    if(el) el.value = (s && s.endTime) || '';
    const au = document.getElementById('f-audiourl');
    if(au) au.value = (s && s.audioUrl) || '';
  }catch(e){}
};

// ── 4.  AUGMENT CARDS WITH END TIME + TIMEZONE LABELS ─────────────────────
function _getPrevStop(dayIdx, stopIdx){
  try{
    const days = state.days;
    if(stopIdx > 0) return days[dayIdx].stops[stopIdx-1];
    if(dayIdx > 0){ const pd=days[dayIdx-1]; return pd.stops.length ? pd.stops[pd.stops.length-1] : null; }
  }catch(e){}
  return null;
}

function _tzOf(stop){ return (stop && typeof stopTz === 'function') ? stopTz(stop) : null; }

function augmentCards(){
  if(typeof state === 'undefined' || !state) return;
  document.querySelectorAll('.stop-card').forEach(card => {
    if(card.dataset.extAdded) return;
    card.dataset.extAdded = '1';
    const m = (card.id||'').match(/stop-card-(\d+)-(\d+)/);
    if(!m) return;
    const di=+m[1], si=+m[2];
    const stop = state?.days?.[di]?.stops?.[si];
    if(!stop) return;
    const timeEl = card.querySelector('.card-time');
    if(!timeEl || !stop.time) return;

    const isTransit = ['flight','train','bus','drive'].includes(stop.type);

    // Transit stops: start-time timezone = origin (previous stop's location)
    if(isTransit){
      const oTz = _tzOf(_getPrevStop(di, si));
      if(oTz && !timeEl.querySelector('.card-tz')){
        const tzSpan=document.createElement('span'); tzSpan.className='card-tz';
        tzSpan.textContent = ' '+oTz.abbr;
        timeEl.appendChild(tzSpan);
      }
    }

    // End time display with destination timezone
    if(stop.endTime && !timeEl.querySelector('.card-endtime')){
      const dTz = _tzOf(stop);
      const endEl = document.createElement('span');
      endEl.className = 'card-endtime';
      endEl.style.cssText = 'display:block;font-size:var(--text-xs);font-weight:600;color:var(--muted);margin-top:var(--space-1);letter-spacing:0.02em;white-space:nowrap';
      endEl.innerHTML = '&#8594; ' + _esc(stop.endTime) + (dTz ? ' <span style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.10em;color:var(--river);opacity:0.85">'+_esc(dTz.abbr)+'</span>' : '');
      timeEl.appendChild(endEl);
    }
  });
}

// ── 4b. PATCH LEG-CONNECTORS (use transit arrival coords when stored) ──────
function _patchLegConnectors(){
  if(typeof state==='undefined'||!state||!state.days) return;
  document.querySelectorAll('.leg-connector').forEach(conn=>{
    if(conn.dataset.distPatched) return;
    const prev=conn.previousElementSibling;
    if(!prev) return;
    const m=(prev.id||'').match(/stop-card-(\d+)-(\d+)/);
    if(!m) return;
    const di=+m[1], si=+m[2];
    const stop=state.days[di]?.stops[si];
    if(!stop||!stop.destLat||!stop.destLng) return;
    const next=state.days[di]?.stops[si+1];
    if(!next||!next.lat||!next.lng) return;
    const dist=haversine(stop.destLat,stop.destLng,next.lat,next.lng);
    const mode=stop.transitMode||(stop.type==='train'?'train':stop.type==='bus'?'bus':'drive');
    for(const node of conn.childNodes){
      if(node.nodeType===Node.TEXT_NODE&&/\d+\.?\d*\s*mi/.test(node.textContent)){
        if(dist<0.08){ node.textContent=' '; }
        else{
          const mi=dist<10?dist.toFixed(1):Math.round(dist);
          node.textContent=mi+' mi · '+_minsToStr(_travelMins(dist,mode))+' ';
        }
        conn.dataset.distPatched='1';
        break;
      }
    }
  });
}

// ── 4c. END-OF-TRIP LABEL (last day "Tonight" → "End of Trip") ────────────
function _patchEndOfTrip(){
  if(typeof state==='undefined'||!state||!state.days) return;
  if(typeof currentDayIdx==='undefined'||currentDayIdx!==state.days.length-1) return;
  const panel=document.querySelector('.day-panel.active');
  if(!panel) return;
  const label=panel.querySelector('.hotel-bookend-label');
  if(label&&/^tonight$/i.test(label.textContent.trim())) label.textContent='End of Trip';
}

// ── 4d. AUDIO TOUR BADGES ──────────────────────────────────────────
// Audio tours are saved to the device using the Cache API on first download,
// so they play fully offline straight from the app — no new browser window.
// The Cache API (unlike fetch+blob) can store cross-origin "opaque" responses,
// so this works even when the audio host doesn't allow CORS. The service
// worker then serves the cached audio to the <audio> element.
const _AUDIO_CACHE='seasons-audio';
async function _audioCached(url){
  try{ const c=await caches.open(_AUDIO_CACHE); return !!(await c.match(url)); }
  catch(e){ return false; }
}
async function _audioSave(url){
  const c=await caches.open(_AUDIO_CACHE);
  let resp;
  // Prefer a CORS fetch (readable, supports seeking); fall back to no-cors
  // (opaque, but still cacheable and playable via the service worker).
  try{
    resp=await fetch(url,{mode:'cors',cache:'no-store'});
    if(!resp.ok) throw new Error('HTTP '+resp.status);
  }catch(e){
    resp=await fetch(url,{mode:'no-cors',cache:'no-store'});
  }
  await c.put(url, resp);
  return true;
}

function _augmentAudioBadges(){
  if(typeof state==='undefined'||!state) return;
  document.querySelectorAll('.stop-card').forEach(card=>{
    if(card.dataset.audioBadged) return;
    const m=(card.id||'').match(/stop-card-(\d+)-(\d+)/);
    if(!m) return;
    const stop=state?.days?.[+m[1]]?.stops?.[+m[2]];
    if(!stop||!stop.audioUrl) return;
    card.dataset.audioBadged='1';
    const url=stop.audioUrl;
    const bar=document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;padding:var(--space-2) var(--space-4) var(--space-2);background:rgba(46,125,82,0.07);border-top:1px solid rgba(46,125,82,0.15);margin-top:var(--space-1);border-radius:0 0 10px 10px';
    bar.innerHTML='<span style="font-size:var(--text-xs);font-weight:700;color:var(--pine);white-space:nowrap">🎤 Audio Tour</span>'+
      '<audio controls preload="none" src="'+_esc(url)+'" style="flex:1;min-width:180px;height:28px"></audio>'+
      '<button type="button" class="audio-save-btn" style="font-size:var(--text-xs);font-weight:600;color:var(--pine);background:none;cursor:pointer;white-space:nowrap;padding:var(--space-1) var(--space-2);border:1px solid rgba(46,125,82,0.4);border-radius:6px">⬇ Save to device</button>';
    card.appendChild(bar);
    const btn=bar.querySelector('.audio-save-btn');
    const _markSaved=()=>{
      btn.textContent='✓ Saved on device'; btn.disabled=true;
      btn.style.cssText+=';opacity:0.7;cursor:default;border-color:rgba(46,125,82,0.25)';
    };
    // The <audio src> streams over the network until saved; once saved, the
    // service worker transparently serves it from the cache (works offline).
    _audioCached(url).then(saved=>{ if(saved) _markSaved(); });
    btn.addEventListener('click',async()=>{
      if(btn.disabled) return;
      const orig=btn.textContent; btn.textContent='Saving…'; btn.disabled=true;
      try{
        await _audioSave(url);
        _markSaved();
      }catch(e){
        btn.textContent='⚠ Couldn\'t save — tap to retry'; btn.disabled=false;
        setTimeout(()=>{ if(!btn.disabled) btn.textContent=orig; },4000);
      }
    });
  });
}

function _startObserver(){
  _injectFormField();
  augmentCards();
  _patchLegConnectors();
  _patchEndOfTrip();
  _augmentAudioBadges();
  if(_syncOvernightArrivals()){ try{saveState('',true);}catch(e){} try{renderAll();}catch(e){} }
  let _oaInitDone=false;
  const ca = document.getElementById('content-area');
  if(ca) new MutationObserver(()=>{
    augmentCards();
    _patchLegConnectors();
    _patchEndOfTrip();
    _augmentAudioBadges();
    if(!_oaInitDone && typeof state!=='undefined' && state && state.days){
      _oaInitDone=true;
      if(_syncOvernightArrivals()){ try{saveState('',true);}catch(e){} try{renderAll();}catch(e){} }
    }
  }).observe(ca, {childList:true, subtree:true});
  const mo = document.getElementById('modal-overlay');
  if(mo) new MutationObserver(_injectFormField).observe(mo, {attributes:true, attributeFilter:['class']});
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', _startObserver);
else setTimeout(_startObserver, 0);


// ── 5.  OVERNIGHT TRAVEL AUTO-ARRIVAL ─────────────────────────────────────
function _parseMinutes(t){
  if(!t) return -1;
  const m=String(t).match(/(\d+):(\d+)\s*(am|pm)?/i);
  if(!m) return -1;
  let h=+m[1], min=+m[2];
  const ap=(m[3]||'').toLowerCase();
  if(ap==='pm'&&h!==12) h+=12;
  if(ap==='am'&&h===12) h=0;
  return h*60+min;
}

let _oaSyncing=false;
// Overnight-arrival stops the user has deleted — don't regenerate these.
let _dismissedArr=null;
function _dismKey(){ return 'oa_dismissed_'+(typeof tripId!=='undefined'?tripId:''); }
function _loadDism(){
  if(_dismissedArr)return _dismissedArr;
  try{ _dismissedArr=new Set(JSON.parse(localStorage.getItem(_dismKey())||'[]')); }catch(e){ _dismissedArr=new Set(); }
  return _dismissedArr;
}
function _dismissArrival(name,time){
  const s=_loadDism(); s.add((name||'')+'|'+(time||''));
  try{ localStorage.setItem(_dismKey(),JSON.stringify([...s])); }catch(e){}
}
// DISABLED. This used to CREATE a duplicate "arrival" stop at the top of the next
// day for any overnight travel. That is the wrong model: a stop is ONE event with a
// start (date + time) and an end (date + time). If it ends on a later date it is
// still one event, shown as a continuation on the next day — not a second stop the
// user then has to manage or delete. It now only STRIPS the duplicates it created
// before, so existing itineraries clean themselves up once.
function _syncOvernightArrivals(){
  if(_oaSyncing) return false;
  if(typeof state==='undefined'||!state||!state.days) return false;
  _oaSyncing=true;
  let removed=false;
  state.days.forEach(day=>{
    if(!day.stops)return;
    const before=day.stops.length;
    day.stops=day.stops.filter(s=>!s._autoArrival);
    if(day.stops.length!==before)removed=true;
  });
  _oaSyncing=false;
  return removed;
}
function _syncOvernightArrivals_DISABLED(){
  if(_oaSyncing) return false;
  if(typeof state==='undefined'||!state||!state.days) return false;
  _oaSyncing=true;
  const transit=['flight','train','bus','drive'];
  const dism=_loadDism();
  // Clear previously auto-created arrival stops, then re-derive from current data
  state.days.forEach(day=>{ if(day.stops) day.stops=day.stops.filter(s=>!s._autoArrival); });
  let changed=false;
  state.days.forEach((day,di)=>{
    if(di>=state.days.length-1) return;
    (day.stops||[]).forEach(stop=>{
      if(!transit.includes(stop.type)||!stop.time||!stop.endTime) return;
      const sm=_parseMinutes(stop.time), em=_parseMinutes(stop.endTime);
      if(sm<0||em<0||em>=sm) return; // not overnight
      if(dism.has((stop.name||'')+'|'+(stop.endTime||'')))return; // user deleted this arrival
      state.days[di+1].stops.unshift({
        name:stop.name, type:stop.type, time:stop.endTime,
        _autoArrival:true
      });
      changed=true;
    });
  });
  _oaSyncing=false;
  return changed;
}


// ── 6.  AI CHAT — CHANGE-AWARE PROMPT + CONFIRMATION ──────────────────────
// Build a 0-based index map of the live itinerary for the AI.
function _itinMap(){
  try{
    if(!state || !state.days) return '';
    // The SINGLE copy of the itinerary sent to the AI. It carries everything the
    // old verbose context did (type, date, notes) so the conversation seed no
    // longer needs to duplicate it — halving the request size, which was large
    // enough on long trips to make the request fail.
    const start=(typeof dayDateStr==='function'?(dayDateStr(0)||''):'');
    return '\n\nLIVE ITINERARY'+(start?' (starts '+start+')':'')+' — use these exact 0-based indices in ITINERARY_CHANGES:\n'+
      state.days.map((d,i)=>
        'dayIdx='+i+' "Day '+(i+1)+': '+(d.title||'')+'"'+(d.subtitle?' ('+d.subtitle+')':'')+':\n'+
        (d.stops||[]).map((s,j)=>'  stopIdx='+j+' "'+s.name+'" ['+(s.type||'')+']'+(s.time?' @'+s.time:'')+(s.duration?' ('+s.duration+')':'')+(s.dayHours?' [open: '+s.dayHours+']':'')+(s.notes?' -- '+s.notes:'')).join('\n')
      ).join('\n');
  }catch(e){ return ''; }
}

const _PLAN_SYS='You are an expert travel planning assistant embedded in a live itinerary app. You CAN make direct changes to the itinerary.\n\nThe full itinerary is already in this conversation. NEVER claim you cannot see it or ask the user to paste it.\n\nCRITICAL: Your prose alone does NOT change anything. A change is applied ONLY when you output an <ITINERARY_CHANGES> block. Never say a change was made unless that block is present in the same reply.\n\nWhen the user asks to add, remove, move, or modify anything: (1) confirm briefly in one sentence, (2) output an <ITINERARY_CHANGES>[ ...JSON array... ]</ITINERARY_CHANGES> block.\n\nEach JSON entry needs "action" and "description", plus:\n- update_stop: dayIdx, dayName, stopIdx, stopName, updates:{field:value} (fields: name, type, time, endTime, duration, notes, dayHours)\n- add_stop: dayIdx, dayName, insertIdx(optional), stop:{name, type, time?, endTime?, duration?, notes?, lat?, lng?}\n- remove_stop: dayIdx, dayName, stopIdx, stopName\n- move_stop: fromDayIdx, fromDayName, fromStopIdx, stopName, toDayIdx, toDayName, toStopIdx\n\nALWAYS include "stopName" (the stop\'s EXACT current name from the index map) and "dayName" (the day\'s title) on every update_stop/remove_stop/move_stop — they are used to target the correct stop even if positions shifted. Use the 0-based dayIdx/stopIdx too, but the names are the source of truth.\n\nNEVER change a stop\'s coordinates (lat/lng) in update_stop — you cannot see the true location and would move the map pin to the wrong place. Location changes are done by the user, not you.\n\nTo correct a stop\'s opening hours, use update_stop with updates:{"dayHours":"9:30 AM - 5:00 PM"} (the displayed opening-hours line is the "dayHours" field). Use "Closed <weekday>" if closed that day.\n\nStop type is one of: hike, food, lodge, drive, flight, train, bus. Provide lat/lng for new places when you know them. Use the EXACT 0-based dayIdx/stopIdx from the LIVE ITINERARY index map. For pure questions/advice, answer normally with no block.\n\nPRESERVE LODGING (very important): The overnight hotel (type "lodge") is where the traveler sleeps. NEVER remove, delete, or drop a lodging stop, and never change a lodging stop to a different type, even when reordering or optimizing a day. Every day that ends with an overnight stay must keep its hotel as the last stop. Only touch a hotel if the user EXPLICITLY asks to change or remove that hotel. When you reorder a day, leave the end-of-day hotel exactly where it is.\n\nTYPE "lodge" IS ONLY FOR REAL ACCOMMODATION: Assign type "lodge" ONLY to an actual place the traveler sleeps overnight (a hotel, motel, hostel, inn, B&B, guesthouse, or resort). It is a hard error to label a walk, tour, hike, museum, castle, palace, cathedral, market, park, restaurant, cafe, or any sightseeing activity as "lodge". Those are "hike" or "food". The traveler does not sleep on the city walls, in a museum, or at a restaurant. If a day has no hotel because they are continuing a multi-night stay, do NOT invent one or relabel an activity as the hotel; leave the day without a lodge stop.\n\nFEASIBILITY, NOT PACE: Do NOT judge or assume pace. Never call a day too rushed, too packed, too ambitious, too slow, or too empty, and never add or remove stops merely to change the pace or to give the traveler downtime. Whether a plan works is decided ONLY by concrete facts: (1) is each stop OPEN at the planned time (opening hours and days closed), (2) the mode of travel between stops, (3) realistic travel time including typical traffic, and (4) distance. Only flag a stop as a problem when it would be closed at that time, or when travel time plus visit time makes the next stop impossible to reach while it is open. When the user asks whether a day works, answer the concrete question: can it be done? For each concern, name the stop, whether it is open, the travel mode, the distance, and the approximate travel time.\n\nDESCRIBE CHANGES IN PLAIN LANGUAGE: In your prose to the user, describe every suggested change in plain English (for example: "Move York Minster before the museum so you arrive at opening time"). NEVER write the internal action names add_stop, remove_stop, update_stop, or move_stop in your prose. Always fill each change\'s "description" field with a clear human sentence that names the stop and says what changes.\n\nSCHEDULING RULES -- follow every time you add, move, or set the time of a stop:\n1. OPENING HOURS: Never place or recommend a stop at a time it is closed. Use the [open: ...] hours shown for each stop in the itinerary map. If hours are not shown, use typical hours: most museums and attractions open about 9-10am and close about 5pm (some close one weekday); shops about 9am-6pm. If a place would be closed at the chosen time, pick a time when it is open, or do not add it. Never recommend a place that is closed that day.\n2. MEALS -- one breakfast, one lunch, one dinner per day, never a second one. Use these EXACT DURATIONS unless the user asks otherwise: breakfast 30 minutes, lunch 45 minutes, dinner 1 hour 15 minutes. A quick coffee, bakery, gelato or snack stop is 30 minutes. NEVER give a meal a 2-hour block -- that is dead time, not dining. Windows: breakfast 7:00-9:00am, lunch 12:00-1:30pm (never before 11:30am or after 2:30pm), dinner 6:00-8:00pm (never before 5:30pm). Always set BOTH a start time and an end time that match the duration above.\n3. CHRONOLOGICAL ORDER + TRAVEL TIME: Every stop must have a time, and times must increase through the day. CRITICALLY, a stop cannot start before you could physically get there: its start time must be AT LEAST the previous stop\'s end time PLUS the travel time between them. If lunch ends at 12:45 PM and the drive to the next stop is 1 hour 46 minutes, that next stop cannot start before ~2:31 PM — never 1:30 PM. Account for the real drive/walk/train time on every leg; when unsure, leave a generous buffer. It is a hard error to schedule a stop earlier than its earliest possible arrival.\n4. FEASIBILITY / DENSITY: A stop takes time to travel to and to visit. The visit times plus the travel between stops must fit the waking day. Do NOT overpack -- an impossible day like 11 stops in 12 hours is wrong. A realistic full day is roughly 4-6 substantial stops plus meals. If the user wants more than fits, say so and offer to move some to another day rather than cramming them in.\n5. NO DEAD TIME: never leave unexplained gaps. A stop should begin about when you could actually arrive from the previous one -- the previous stop\'s end time plus travel. A gap longer than ~45 minutes is only acceptable when there is a REASON: a booked time, an opening-hour constraint, or a meal window. Otherwise close the gap by starting the next stop earlier, or fill it with something worth doing. Equally, never overlap two stops or schedule one before you could reach it -- both are hard errors. Before you output any change, re-check every stop you touched: start >= previous end + travel, and end = start + the stated duration.';

// Detect when the AI claims a change without emitting the block (so we can
// silently fetch the structured block instead of leaving the user confused).
const _claimRe = /\b(i(?:'ll| will| am going to| have| 've)\s+(?:add|update|change|remove|move|set|modif|delet|creat|swap|replac)|(?:adding|updating|changing|removing|moving|setting)\s+(?:the|your|it|that|a )|that(?:'s| is)\s+(?:now\s+)?(?:updated|added|changed|set|removed|moved)|i've\s+(?:added|updated|changed)|done[!.])/i;

// Map _pcHistory ({role,content}) into a plain transcript for callClaude.
function _convo(){
  try{ return _pcHistory.map(m=>m.role+': '+m.content).join('\n\n'); }
  catch(e){ return ''; }
}

// Replace _planCallAI — reuses the REAL _pcHistory (already seeded with the
// itinerary by openPlanChat) and an enhanced system prompt.
window._planCallAI = async function(userText){
  const msgs=document.getElementById('pc-messages');
  const thk=document.createElement('div');
  thk.className='tg-msg tg-thinking'; thk.textContent='Thinking…';
  if(msgs){ msgs.appendChild(thk); msgs.scrollTop=msgs.scrollHeight; }
  try{ _pcHistory.push({role:'user',content:userText}); }catch(e){}
  try{
    const text = await callClaude(_PLAN_SYS+_itinMap(), _convo());
    if(thk.parentNode) thk.parentNode.removeChild(thk);
    const changeM = text.match(/<ITINERARY_CHANGES>([\s\S]*?)<\/ITINERARY_CHANGES>/i);
    const display = _cleanChangeText(text.replace(/<ITINERARY_CHANGES>[\s\S]*?<\/ITINERARY_CHANGES>/gi,'').trim());
    try{ _pcHistory.push({role:'assistant',content:display||text}); }catch(e){}
    _pcAddMessage('assistant', display||text);
    if(changeM){
      _renderChangePanel(changeM[1]);
    } else if(_claimRe.test(display)){
      _autoExtract();   // AI described a change but forgot the block
    }
  }catch(e){
    if(thk.parentNode) thk.parentNode.removeChild(thk);
    // Surface the REAL failure so a size/rate-limit/server error is visible
    // instead of a generic "could not reach" that hides the cause.
    const why=(e&&e.message)?String(e.message):'could not reach the server';
    _pcAddMessage('error','AI request failed: '+why+'. Please try again.');
  }
};

// Silently ask the AI for just the structured block when it omitted one.
async function _autoExtract(){
  const msgs=document.getElementById('pc-messages');
  const thk=document.createElement('div');
  thk.className='tg-msg tg-thinking'; thk.textContent='Preparing changes…';
  if(msgs){ msgs.appendChild(thk); msgs.scrollTop=msgs.scrollHeight; }
  const sys='You previously described itinerary changes but omitted the required block. Output ONLY a <ITINERARY_CHANGES>[ ...JSON array... ]</ITINERARY_CHANGES> block capturing exactly those changes, using the EXACT 0-based indices from the index map. Output nothing else.'+_itinMap();
  try{
    const text=await callClaude(sys, _convo()+'\n\nuser: Output the ITINERARY_CHANGES block for the change you just described.');
    if(thk.parentNode) thk.parentNode.removeChild(thk);
    const changeM=text.match(/<ITINERARY_CHANGES>([\s\S]*?)<\/ITINERARY_CHANGES>/i);
    if(changeM) _renderChangePanel(changeM[1]);
  }catch(e){
    if(thk.parentNode) thk.parentNode.removeChild(thk);
  }
}

// Plain-English fallback when the AI omits a description — never show the raw
// action name (add_stop / remove_stop / ...).
function _humanizeChange(c){
  try{
    const di = (c.dayIdx!=null?c.dayIdx:(c.fromDayIdx!=null?c.fromDayIdx:null));
    const day = (di!=null && state.days)?state.days[di]:null;
    const nameAt = (i)=> (day && i!=null && day.stops && day.stops[i])?day.stops[i].name:'';
    const dayN = c.dayIdx!=null?(' on Day '+(c.dayIdx+1)):'';
    if(c.action==='add_stop')   return 'Add '+((c.stop&&c.stop.name)||'a new stop')+(c.dayIdx!=null?(' to Day '+(c.dayIdx+1)):'');
    if(c.action==='remove_stop') return 'Remove '+(nameAt(c.stopIdx)||'a stop')+(c.dayIdx!=null?(' from Day '+(c.dayIdx+1)):'');
    if(c.action==='update_stop') return 'Update '+(nameAt(c.stopIdx)||'a stop')+dayN;
    if(c.action==='move_stop')   return 'Move '+(nameAt(c.fromStopIdx)||'a stop')+(c.toDayIdx!=null?(' to Day '+(c.toDayIdx+1)):'');
  }catch(e){}
  return 'Update the itinerary';
}
// Strip any internal action tokens the AI may have leaked into human text.
function _cleanChangeText(t){
  return String(t||'').replace(/\b(add_stop|remove_stop|update_stop|move_stop)\b/gi, m=>({
    add_stop:'add', remove_stop:'remove', update_stop:'update', move_stop:'move'
  }[m.toLowerCase()]||'change'));
}
function _renderChangePanel(jsonStr){
  let changes;
  try{ changes = JSON.parse(jsonStr.trim()); }catch(e){ console.warn('[trip-extras] bad change JSON:', e); return; }
  if(!Array.isArray(changes) || !changes.length) return;
  const msgs = document.getElementById('pc-messages');
  if(!msgs) return;

  const panel = document.createElement('div');
  panel.style.cssText = 'margin:var(--space-3) 0 var(--space-1);padding:var(--space-3) var(--space-4);background:rgba(46,125,82,0.09);border:1.5px solid rgba(46,125,82,0.30);border-radius:12px;font-family:var(--font-ui)';

  let rows = '';
  changes.forEach((c,i) => {
    rows += '<div style="padding:var(--space-1) 0;font-size:var(--text-sm);color:var(--ink-soft);border-bottom:1px solid rgba(46,125,82,0.12)">'+
      '<strong style="color:var(--pine)">'+(i+1)+'.</strong> '+_esc(_cleanChangeText(c.description)||_humanizeChange(c))+'</div>';
  });

  panel.innerHTML =
    '<div style="font-size:var(--text-xs);font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--pine);margin-bottom:var(--space-2)">'+
      changes.length+' Proposed Change'+(changes.length!==1?'s':'')+'</div>'+
    rows+
    '<div style="display:flex;gap:var(--space-2);margin-top:var(--space-3)">'+
      '<button class="_ext-apply-btn" style="flex:1;padding:var(--space-2) var(--space-3);background:var(--pine);color:#fff;border:none;border-radius:8px;font-family:var(--font-ui);font-size:var(--text-sm);font-weight:600;cursor:pointer">&#10003; Apply Changes</button>'+
      '<button class="_ext-disc-btn" style="padding:var(--space-2) var(--space-4);background:transparent;color:var(--ruby);border:1.5px solid rgba(194,59,59,0.30);border-radius:8px;font-family:var(--font-ui);font-size:var(--text-sm);font-weight:600;cursor:pointer">&#215; Discard</button>'+
    '</div>';

  panel.querySelector('._ext-apply-btn').addEventListener('click', ()=>{ _applyChanges(changes); panel.remove(); });
  panel.querySelector('._ext-disc-btn').addEventListener('click', ()=> panel.remove());
  msgs.appendChild(panel);
  msgs.scrollTop = msgs.scrollHeight;
}

// Resolve a DAY by its title first (robust to index drift / off-by-one), then a
// strict 0-based index. No 1-vs-0 guessing — that landed edits on the wrong day.
function _resolveDay(dayIdx, dayName){
  const days=state.days||[];
  if(dayName){
    const key=String(dayName).toLowerCase().trim();
    let i=days.findIndex(d=>String(d.title||'').toLowerCase().trim()===key);
    if(i>=0)return i;
    i=days.findIndex(d=>{const t=String(d.title||'').toLowerCase().trim();return t&&key.length>3&&(t.includes(key)||key.includes(t));});
    if(i>=0)return i;
  }
  if(Number.isInteger(dayIdx)&&dayIdx>=0&&dayIdx<days.length)return dayIdx;
  return -1;
}
// Resolve the target STOP by its name first (stable across index drift and any
// 0-vs-1-based confusion), then a strict 0-based index. This is what stops an
// edit meant for stop C from silently landing on stop D.
function _resolveStop(day, stopIdx, stopName){
  if(!day||!day.stops)return -1;
  const stops=day.stops;
  if(stopName){
    const key=String(stopName).toLowerCase().trim();
    let i=stops.findIndex(s=>String(s.name||'').toLowerCase().trim()===key);
    if(i>=0)return i;
    i=stops.findIndex(s=>{const n=String(s.name||'').toLowerCase().trim();return n&&key.length>3&&(n.includes(key)||key.includes(n));});
    if(i>=0)return i;
  }
  if(Number.isInteger(stopIdx)&&stopIdx>=0&&stopIdx<stops.length)return stopIdx;
  return -1;
}
const _VALID_STOP_TYPES=['hike','food','lodge','drive','flight','train','bus'];

// Is this stop the overnight hotel/lodging? Reuse trip.js's detector when it is
// loaded (name-aware, catches hotels mistyped as food); fall back to type.
function _extIsLodge(s){
  if(!s) return false;
  try{ if(typeof _isLodgeStop==='function') return _isLodgeStop(s); }catch(e){}
  return s.type==='lodge';
}
// Put a day's stops back into chronological order by start time. Stops without a
// time stay anchored just after the previous timed stop (carry-forward) rather
// than being dumped at the end, so they never jump out of order.
function _sortDayChrono(day){
  if(!day || !day.stops || day.stops.length<2) return;
  const pt=(s)=>{ try{ return _parseTimeMins(s.time); }catch(e){ return null; } };
  const timed=day.stops.filter(s=>pt(s)!==null);
  if(timed.length<2)return;
  let last=-1;
  const arr=day.stops.map((s,i)=>{
    let m=pt(s);
    if(m===null){ m=(last>=0?last:0)+0.001; } else last=m;
    return {s,i,m};
  });
  arr.sort((a,b)=>(a.m-b.m)||(a.i-b.i));
  day.stops=arr.map(x=>x.s);
}

function _applyChanges(changes){
  let ok=0, fail=[], protectedN=0;
  changes.forEach(c => {
    try{
      if(c.action==='update_stop'){
        const di=_resolveDay(c.dayIdx,c.dayName); const day=state.days[di];
        const si=_resolveStop(day,c.stopIdx,c.stopName);
        if(di<0||si<0||!day) throw new Error('stop not found');
        const upd=Object.assign({}, c.updates||{});
        // NEVER let an AI edit move a stop's location — hallucinated coordinates
        // silently corrupt the map. Coordinates change only via search / Fix pin.
        delete upd.lat; delete upd.lng;
        // Only accept a valid stop type.
        if(upd.type && !_VALID_STOP_TYPES.includes(upd.type)) delete upd.type;
        // Never let the AI turn the overnight hotel into a non-lodging stop.
        if(_extIsLodge(day.stops[si]) && upd.type && upd.type!=='lodge'){ delete upd.type; protectedN++; }
        Object.assign(day.stops[si], upd);
        // Hours the AI set on request are authoritative — don't let auto-refresh overwrite them.
        if('dayHours' in upd) day.stops[si].dayHoursSrc='user';
        // Never let an activity (a walk/tour/museum) be labelled as lodging.
        if(day.stops[si].type==='lodge' && !_extIsLodge(day.stops[si])){ day.stops[si].type='hike'; }
        ok++;
      } else if(c.action==='add_stop'){
        const di=_resolveDay(c.dayIdx,c.dayName); const day=state.days[di];
        if(di<0||!day) throw new Error('day not found');
        const ins=c.insertIdx!=null ? Math.min(Math.max(0,c.insertIdx), day.stops.length) : day.stops.length;
        // Do NOT default coordinates to 0,0 (a real point off West Africa). Leave
        // them unset so the stop is treated as coordinate-less consistently.
        const ns=Object.assign({name:'New Stop',type:'hike'}, c.stop||{});
        if(!_VALID_STOP_TYPES.includes(ns.type)) ns.type='hike';
        // Reject an out-of-range coordinate outright (bad geocode).
        if(!(Number.isFinite(ns.lat)&&Number.isFinite(ns.lng)&&Math.abs(ns.lat)<=90&&Math.abs(ns.lng)<=180)){ delete ns.lat; delete ns.lng; }
        // A new stop can only be 'lodge' if it actually looks like a hotel.
        if(ns.type==='lodge' && !_extIsLodge(ns)){ ns.type='hike'; }
        day.stops.splice(ins, 0, ns);
        ok++;
      } else if(c.action==='remove_stop'){
        const di=_resolveDay(c.dayIdx,c.dayName); const day=state.days[di];
        const si=_resolveStop(day,c.stopIdx,c.stopName);
        if(di<0||si<0||!day) throw new Error('stop not found');
        // MISTAKE-PROOF: refuse to delete the overnight hotel. The user can still
        // remove a hotel manually via the stop card's own delete button.
        if(_extIsLodge(day.stops[si])){ protectedN++; return; }
        day.stops.splice(si,1);
        ok++;
      } else if(c.action==='move_stop'){
        const fdi=_resolveDay(c.fromDayIdx,c.fromDayName), tdi=_resolveDay(c.toDayIdx,c.toDayName);
        const fday=state.days[fdi], tday=state.days[tdi];
        const fsi=_resolveStop(fday,c.fromStopIdx,c.stopName||c.fromStopName);
        if(fdi<0||tdi<0||fsi<0||!fday||!tday) throw new Error('stop not found');
        const [s]=fday.stops.splice(fsi,1);
        tday.stops.splice(Math.min(c.toStopIdx||0,tday.stops.length),0,s);
        ok++;
      } else {
        throw new Error('unknown action: '+c.action);
      }
    }catch(e){ console.warn('[trip-extras] apply failed:', c, e); fail.push(c.description||c.action); }
  });
  // HARD GUARD: put every touched day back into chronological order so the AI can
  // never leave stops out of time order.
  const touched=new Set();
  changes.forEach(c=>{
    [[c.dayIdx,c.dayName],[c.toDayIdx,c.toDayName],[c.fromDayIdx,c.fromDayName]].forEach(([v,nm])=>{ const di=_resolveDay(v,nm); if(di>=0)touched.add(di); });
  });
  touched.forEach(di=>_sortDayChrono(state.days[di]));
  _syncOvernightArrivals();
  try{ saveState(); }catch(e){ console.warn('[trip-extras] saveState failed:', e); }
  try{ renderAll(); }catch(e){ console.warn('[trip-extras] renderAll failed:', e); }
  const msg = ok+' change'+(ok!==1?'s':'')+' applied'+
    (protectedN?' ('+protectedN+' hotel'+(protectedN!==1?'s':'')+' kept)':'')+
    (fail.length?' ('+fail.length+' failed)':'')+'!';
  const toast=document.getElementById('share-toast');
  if(toast){ toast.textContent=msg; toast.classList.add('visible'); setTimeout(()=>toast.classList.remove('visible'),3500); }
}

// ✶ Request Changes — manual fallback button under the chat input.
function _injectPlanChatBtn(){
  const content = document.getElementById('pc-content');
  if(!content || content.dataset.extBtn) return;
  const obs = new MutationObserver(()=>{
    const row = content.querySelector('.tg-input-row');
    if(!row || row.dataset.extBtnAdded) return;
    row.dataset.extBtnAdded='1';
    const btn = document.createElement('button');
    btn.textContent = '✶ Request Changes';
    btn.title = 'Turn the AI suggestions in this chat into applyable edits';
    btn.style.cssText = 'display:block;width:100%;margin-top:var(--space-2);padding:var(--space-2);background:rgba(46,125,82,0.09);color:var(--pine);border:1.5px dashed rgba(46,125,82,0.38);border-radius:8px;font-family:var(--font-ui);font-size:var(--text-sm);font-weight:600;cursor:pointer;transition:all 0.18s;letter-spacing:0.02em';
    btn.onmouseover=()=>{btn.style.background='var(--pine)';btn.style.color='#fff';btn.style.borderStyle='solid';};
    btn.onmouseout=()=>{btn.style.background='rgba(46,125,82,0.09)';btn.style.color='var(--pine)';btn.style.borderStyle='dashed';};
    btn.addEventListener('click', _requestStructuredChanges);
    row.after(btn);
    obs.disconnect();
    content.dataset.extBtn='1';
  });
  obs.observe(content,{childList:true,subtree:true});
}

const _planModal = document.getElementById('plan-chat-modal');
if(_planModal){
  new MutationObserver(ms=>ms.forEach(m=>{ if(m.target.classList.contains('open')) _injectPlanChatBtn(); }))
    .observe(_planModal,{attributes:true,attributeFilter:['class']});
}

async function _requestStructuredChanges(){
  let hasChat=false;
  try{ hasChat = _pcHistory.some(m=>m.role==='assistant'); }catch(e){}
  if(!hasChat){ alert('Chat with the AI first, then click this to turn its suggestions into edits.'); return; }
  const msgs = document.getElementById('pc-messages');
  if(!msgs) return;
  const thk = document.createElement('div');
  thk.className='tg-msg tg-thinking'; thk.textContent='Generating change list…';
  msgs.appendChild(thk); msgs.scrollTop=msgs.scrollHeight;

  const sys = 'Extract every itinerary change discussed in this conversation and output ONLY a <ITINERARY_CHANGES>[ ...JSON array... ]</ITINERARY_CHANGES> block. Each entry: action (update_stop|add_stop|remove_stop|move_stop), description, and the relevant fields. update_stop:{dayIdx,stopIdx,updates:{}}. add_stop:{dayIdx,insertIdx?,stop:{name,type,...}}. remove_stop:{dayIdx,stopIdx}. Use EXACT 0-based indices from the index map. Output nothing outside the tags.'+_itinMap();
  try{
    const text = await callClaude(sys, _convo()+'\n\nuser: Output the ITINERARY_CHANGES block for the changes suggested in this conversation.');
    if(thk.parentNode) thk.parentNode.removeChild(thk);
    const changeM = text.match(/<ITINERARY_CHANGES>([\s\S]*?)<\/ITINERARY_CHANGES>/i);
    if(changeM){ _renderChangePanel(changeM[1]); }
    else{
      const err=document.createElement('div');
      err.className='tg-msg tg-msg-err';
      err.textContent='No changes found yet. Ask the AI to add, remove, move, or retime a stop, then try again.';
      msgs.appendChild(err); msgs.scrollTop=msgs.scrollHeight;
    }
  }catch(e){
    if(thk.parentNode) thk.parentNode.removeChild(thk);
  }
}

})();
