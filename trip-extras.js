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
const _origSaveStop = window.saveStop;
window.saveStop = function(){
  const wasEditing = (typeof editingStop !== 'undefined' && editingStop)
    ? {dayIdx:editingStop.dayIdx, stopIdx:editingStop.stopIdx} : null;
  const addDay = (typeof addingToDay !== 'undefined') ? addingToDay : null;
  const endTimeVal = (document.getElementById('f-endtime')||{}).value || '';
  const audioUrlVal = (document.getElementById('f-audiourl')||{}).value || '';

  _origSaveStop.apply(this, arguments);

  try{
    if(wasEditing){
      const s = state.days[wasEditing.dayIdx].stops[wasEditing.stopIdx];
      if(s){
        if(endTimeVal) s.endTime=endTimeVal; else delete s.endTime;
        if(audioUrlVal) s.audioUrl=audioUrlVal; else delete s.audioUrl;
        saveState();
      }
    } else if(addDay != null){
      const day = state.days[addDay];
      if(day && day.stops.length){
        const s = day.stops[day.stops.length-1];
        if(endTimeVal) s.endTime=endTimeVal; else delete s.endTime;
        if(audioUrlVal) s.audioUrl=audioUrlVal; else delete s.audioUrl;
        saveState();
      }
    }
  }catch(e){ console.warn('[trip-extras] save failed:', e); }
  if(_syncOvernightArrivals()){ try{saveState();}catch(e){} try{renderAll();}catch(e){} }
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
      endEl.style.cssText = 'display:block;font-size:10px;font-weight:600;color:var(--muted);margin-top:3px;letter-spacing:0.02em;white-space:nowrap';
      endEl.innerHTML = '&#8594; ' + _esc(stop.endTime) + (dTz ? ' <span style="font-size:9px;font-weight:700;letter-spacing:0.10em;color:var(--river);opacity:0.85">'+_esc(dTz.abbr)+'</span>' : '');
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
    bar.style.cssText='display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 14px 8px;background:rgba(46,125,82,0.07);border-top:1px solid rgba(46,125,82,0.15);margin-top:2px;border-radius:0 0 10px 10px';
    bar.innerHTML='<span style="font-size:11px;font-weight:700;color:var(--pine);white-space:nowrap">🎤 Audio Tour</span>'+
      '<audio controls preload="none" src="'+_esc(url)+'" style="flex:1;min-width:180px;height:28px"></audio>'+
      '<button type="button" class="audio-save-btn" style="font-size:11px;font-weight:600;color:var(--pine);background:none;cursor:pointer;white-space:nowrap;padding:3px 8px;border:1px solid rgba(46,125,82,0.4);border-radius:6px">⬇ Save to device</button>';
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
  if(_syncOvernightArrivals()){ try{saveState();}catch(e){} try{renderAll();}catch(e){} }
  let _oaInitDone=false;
  const ca = document.getElementById('content-area');
  if(ca) new MutationObserver(()=>{
    augmentCards();
    _patchLegConnectors();
    _patchEndOfTrip();
    _augmentAudioBadges();
    if(!_oaInitDone && typeof state!=='undefined' && state && state.days){
      _oaInitDone=true;
      if(_syncOvernightArrivals()){ try{saveState();}catch(e){} try{renderAll();}catch(e){} }
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
function _syncOvernightArrivals(){
  if(_oaSyncing) return false;
  if(typeof state==='undefined'||!state||!state.days) return false;
  _oaSyncing=true;
  const transit=['flight','train','bus','drive'];
  // Clear previously auto-created arrival stops, then re-derive from current data
  state.days.forEach(day=>{ if(day.stops) day.stops=day.stops.filter(s=>!s._autoArrival); });
  let changed=false;
  state.days.forEach((day,di)=>{
    if(di>=state.days.length-1) return;
    (day.stops||[]).forEach(stop=>{
      if(!transit.includes(stop.type)||!stop.time||!stop.endTime) return;
      const sm=_parseMinutes(stop.time), em=_parseMinutes(stop.endTime);
      if(sm<0||em<0||em>=sm) return; // not overnight
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
    return '\n\nLIVE ITINERARY (use these exact 0-based indices in ITINERARY_CHANGES):\n'+
      state.days.map((d,i)=>
        'dayIdx='+i+' "Day '+(i+1)+': '+(d.title||'')+'": '+
        (d.stops||[]).map((s,j)=>'stopIdx='+j+' "'+s.name+'"'+(s.time?' @'+s.time:'')+(s.duration?' ('+s.duration+')':'')+(s.dayHours?' [open: '+s.dayHours+']':'')).join(' | ')
      ).join('\n');
  }catch(e){ return ''; }
}

const _PLAN_SYS='You are an expert travel planning assistant embedded in a live itinerary app. You CAN make direct changes to the itinerary.\n\nThe full itinerary is already in this conversation. NEVER claim you cannot see it or ask the user to paste it.\n\nCRITICAL: Your prose alone does NOT change anything. A change is applied ONLY when you output an <ITINERARY_CHANGES> block. Never say a change was made unless that block is present in the same reply.\n\nWhen the user asks to add, remove, move, or modify anything: (1) confirm briefly in one sentence, (2) output an <ITINERARY_CHANGES>[ ...JSON array... ]</ITINERARY_CHANGES> block.\n\nEach JSON entry needs "action" and "description", plus:\n- update_stop: dayIdx, stopIdx, updates:{field:value} (fields: name, type, time, endTime, duration, notes, dayHours, lat, lng)\n- add_stop: dayIdx, insertIdx(optional), stop:{name, type, time?, endTime?, duration?, notes?, lat?, lng?}\n- remove_stop: dayIdx, stopIdx\n- move_stop: fromDayIdx, fromStopIdx, toDayIdx, toStopIdx\n\nTo correct a stop\'s opening hours, use update_stop with updates:{"dayHours":"9:30 AM - 5:00 PM"} (the displayed opening-hours line is the "dayHours" field). Use "Closed <weekday>" if closed that day.\n\nStop type is one of: hike, food, lodge, drive, flight, train, bus. Provide lat/lng for new places when you know them. Use the EXACT 0-based dayIdx/stopIdx from the LIVE ITINERARY index map. For pure questions/advice, answer normally with no block.\n\nPRESERVE LODGING (very important): The overnight hotel (type "lodge") is where the traveler sleeps. NEVER remove, delete, or drop a lodging stop, and never change a lodging stop to a different type, even when reordering or optimizing a day. Every day that ends with an overnight stay must keep its hotel as the last stop. Only touch a hotel if the user EXPLICITLY asks to change or remove that hotel. When you reorder a day, leave the end-of-day hotel exactly where it is.\n\nTYPE "lodge" IS ONLY FOR REAL ACCOMMODATION: Assign type "lodge" ONLY to an actual place the traveler sleeps overnight (a hotel, motel, hostel, inn, B&B, guesthouse, or resort). It is a hard error to label a walk, tour, hike, museum, castle, palace, cathedral, market, park, restaurant, cafe, or any sightseeing activity as "lodge". Those are "hike" or "food". The traveler does not sleep on the city walls, in a museum, or at a restaurant. If a day has no hotel because they are continuing a multi-night stay, do NOT invent one or relabel an activity as the hotel; leave the day without a lodge stop.\n\nFEASIBILITY, NOT PACE: Do NOT judge or assume pace. Never call a day too rushed, too packed, too ambitious, too slow, or too empty, and never add or remove stops merely to change the pace or to give the traveler downtime. Whether a plan works is decided ONLY by concrete facts: (1) is each stop OPEN at the planned time (opening hours and days closed), (2) the mode of travel between stops, (3) realistic travel time including typical traffic, and (4) distance. Only flag a stop as a problem when it would be closed at that time, or when travel time plus visit time makes the next stop impossible to reach while it is open. When the user asks whether a day works, answer the concrete question: can it be done? For each concern, name the stop, whether it is open, the travel mode, the distance, and the approximate travel time.\n\nDESCRIBE CHANGES IN PLAIN LANGUAGE: In your prose to the user, describe every suggested change in plain English (for example: "Move York Minster before the museum so you arrive at opening time"). NEVER write the internal action names add_stop, remove_stop, update_stop, or move_stop in your prose. Always fill each change\'s "description" field with a clear human sentence that names the stop and says what changes.\n\nSCHEDULING RULES -- follow every time you add, move, or set the time of a stop:\n1. OPENING HOURS: Never place or recommend a stop at a time it is closed. Use the [open: ...] hours shown for each stop in the itinerary map. If hours are not shown, use typical hours: most museums and attractions open about 9-10am and close about 5pm (some close one weekday); shops about 9am-6pm. If a place would be closed at the chosen time, pick a time when it is open, or do not add it. Never recommend a place that is closed that day.\n2. MEALS: At most ONE breakfast, ONE lunch, and ONE dinner per day -- never a second lunch or second dinner. Breakfast 7:00-9:00am, lunch 12:00-1:30pm, dinner 6:00-8:00pm. Never schedule lunch before 11:30am or after 2:30pm; never schedule dinner before 5:30pm. Do not stack meals close together.\n3. CHRONOLOGICAL ORDER: Every stop must have a time, and times must increase through the day. When you insert a stop, give it a time that fits between its neighbors so the day stays in order.\n4. FEASIBILITY / DENSITY: A stop takes time to travel to and to visit. The visit times plus the travel between stops must fit the waking day. Do NOT overpack -- an impossible day like 11 stops in 12 hours is wrong. A realistic full day is roughly 4-6 substantial stops plus meals. If the user wants more than fits, say so and offer to move some to another day rather than cramming them in.';

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
    _pcAddMessage('error','Could not reach the AI. Please try again.');
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
  panel.style.cssText = 'margin:10px 0 4px;padding:12px 13px;background:rgba(46,125,82,0.09);border:1.5px solid rgba(46,125,82,0.30);border-radius:12px;font-family:var(--font-ui)';

  let rows = '';
  changes.forEach((c,i) => {
    rows += '<div style="padding:5px 0;font-size:12px;color:var(--ink-soft);border-bottom:1px solid rgba(46,125,82,0.12)">'+
      '<strong style="color:var(--pine)">'+(i+1)+'.</strong> '+_esc(_cleanChangeText(c.description)||_humanizeChange(c))+'</div>';
  });

  panel.innerHTML =
    '<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--pine);margin-bottom:8px">'+
      changes.length+' Proposed Change'+(changes.length!==1?'s':'')+'</div>'+
    rows+
    '<div style="display:flex;gap:8px;margin-top:10px">'+
      '<button class="_ext-apply-btn" style="flex:1;padding:8px 12px;background:var(--pine);color:#fff;border:none;border-radius:8px;font-family:var(--font-ui);font-size:12px;font-weight:600;cursor:pointer">&#10003; Apply Changes</button>'+
      '<button class="_ext-disc-btn" style="padding:8px 14px;background:transparent;color:var(--ruby);border:1.5px solid rgba(194,59,59,0.30);border-radius:8px;font-family:var(--font-ui);font-size:12px;font-weight:600;cursor:pointer">&#215; Discard</button>'+
    '</div>';

  panel.querySelector('._ext-apply-btn').addEventListener('click', ()=>{ _applyChanges(changes); panel.remove(); });
  panel.querySelector('._ext-disc-btn').addEventListener('click', ()=> panel.remove());
  msgs.appendChild(panel);
  msgs.scrollTop = msgs.scrollHeight;
}

// Resolve indices: accept 0-based; auto-correct an off-by-one 1-based value.
function _rdi(i){ const n=state.days.length; if(i>=0&&i<n)return i; if(i>0&&i<=n)return i-1; return -1; }
function _rsi(day,i){ const n=(day&&day.stops?day.stops.length:0); if(i>=0&&i<n)return i; if(i>0&&i<=n)return i-1; return -1; }

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
        const di=_rdi(c.dayIdx); const day=state.days[di];
        const si=_rsi(day,c.stopIdx);
        if(di<0||si<0||!day) throw new Error('index out of range');
        const upd=Object.assign({}, c.updates||{});
        // Never let the AI turn the overnight hotel into a non-lodging stop.
        if(_extIsLodge(day.stops[si]) && upd.type && upd.type!=='lodge'){ delete upd.type; protectedN++; }
        Object.assign(day.stops[si], upd);
        // Hours the AI set on request are authoritative — don't let auto-refresh overwrite them.
        if('dayHours' in upd) day.stops[si].dayHoursSrc='user';
        // Never let an activity (a walk/tour/museum) be labelled as lodging.
        if(day.stops[si].type==='lodge' && !_extIsLodge(day.stops[si])){ day.stops[si].type='hike'; }
        ok++;
      } else if(c.action==='add_stop'){
        const di=_rdi(c.dayIdx); const day=state.days[di];
        if(di<0||!day) throw new Error('day not found');
        const ins=c.insertIdx!=null ? Math.min(Math.max(0,c.insertIdx), day.stops.length) : day.stops.length;
        const ns=Object.assign({name:'New Stop',type:'hike',lat:0,lng:0}, c.stop||{});
        // A new stop can only be 'lodge' if it actually looks like a hotel.
        if(ns.type==='lodge' && !_extIsLodge(ns)){ ns.type='hike'; }
        day.stops.splice(ins, 0, ns);
        ok++;
      } else if(c.action==='remove_stop'){
        const di=_rdi(c.dayIdx); const day=state.days[di];
        const si=_rsi(day,c.stopIdx);
        if(di<0||si<0||!day) throw new Error('index out of range');
        // MISTAKE-PROOF: refuse to delete the overnight hotel. The user can still
        // remove a hotel manually via the stop card's own delete button.
        if(_extIsLodge(day.stops[si])){ protectedN++; return; }
        day.stops.splice(si,1);
        ok++;
      } else if(c.action==='move_stop'){
        const fdi=_rdi(c.fromDayIdx), tdi=_rdi(c.toDayIdx);
        const fday=state.days[fdi], tday=state.days[tdi];
        const fsi=_rsi(fday,c.fromStopIdx);
        if(fdi<0||tdi<0||fsi<0||!fday||!tday) throw new Error('index out of range');
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
  changes.forEach(c=>{ [c.dayIdx,c.toDayIdx,c.fromDayIdx].forEach(v=>{ const di=_rdi(v); if(di>=0)touched.add(di); }); });
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
    btn.style.cssText = 'display:block;width:100%;margin-top:7px;padding:8px;background:rgba(46,125,82,0.09);color:var(--pine);border:1.5px dashed rgba(46,125,82,0.38);border-radius:8px;font-family:var(--font-ui);font-size:11.5px;font-weight:600;cursor:pointer;transition:all 0.18s;letter-spacing:0.02em';
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
