// trip-extras.js — end time, timezone labels, AI-itinerary edits with confirmation
//
// IMPORTANT: This is a classic <script> loaded after trip.js. It shares the
// global lexical scope, so trip.js's top-level `let` bindings (state,
// _pcHistory, editingStop, addingToDay) and its function declarations
// (saveState, renderAll, stopTz, callClaude, _pcAddMessage, etc.) are
// referenced HERE BY BARE NAME — NOT via window.X. `let`/`const` globals are
// NOT attached to window, so window.state would be undefined.
(function(){
'use strict';

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── 1.  INJECT END-TIME FIELD INTO ADD/EDIT MODAL ─────────────────────────
function _injectFormField(){
  if(document.getElementById('f-endtime')) return;
  const timeGrp = document.querySelector('#f-time')?.closest('.form-group');
  if(!timeGrp) return;
  const g = document.createElement('div');
  g.className = 'form-group';
  g.innerHTML = '<label class="form-label">End Time</label><input type="text" class="form-input" id="f-endtime" placeholder="e.g. 11:00 AM"/>';
  timeGrp.after(g);
}

// ── 2.  PATCH saveStop TO CAPTURE endTime ─────────────────────────────────
const _origSaveStop = window.saveStop;
window.saveStop = function(){
  // editingStop / addingToDay are trip.js lexical globals — bare names
  const wasEditing = (typeof editingStop !== 'undefined' && editingStop)
    ? {dayIdx:editingStop.dayIdx, stopIdx:editingStop.stopIdx} : null;
  const addDay = (typeof addingToDay !== 'undefined') ? addingToDay : null;
  const endTimeVal = (document.getElementById('f-endtime')||{}).value || '';

  _origSaveStop.apply(this, arguments);

  try{
    if(wasEditing){
      const s = state.days[wasEditing.dayIdx].stops[wasEditing.stopIdx];
      if(s){ if(endTimeVal) s.endTime=endTimeVal; else delete s.endTime; saveState(); }
    } else if(addDay != null){
      const day = state.days[addDay];
      if(day && day.stops.length){
        const s = day.stops[day.stops.length-1];
        if(endTimeVal) s.endTime=endTimeVal; else delete s.endTime;
        saveState();
      }
    }
  }catch(e){ console.warn('[trip-extras] endTime save failed:', e); }
  if(_syncOvernightArrivals()){ try{saveState();}catch(e){} try{renderAll();}catch(e){} }
};

// ── 3.  PATCH openEditStopModal TO PRE-FILL endTime ───────────────────────
const _origOpenEdit = window.openEditStopModal;
window.openEditStopModal = function(dayIdx, stopIdx){
  _origOpenEdit.apply(this, arguments);
  try{
    const s = state.days[dayIdx].stops[stopIdx];
    const el = document.getElementById('f-endtime');
    if(el) el.value = (s && s.endTime) || '';
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

function _startObserver(){
  _injectFormField();
  augmentCards();
  if(_syncOvernightArrivals()){ try{saveState();}catch(e){} try{renderAll();}catch(e){} }
  let _oaInitDone=false;
  const ca = document.getElementById('content-area');
  if(ca) new MutationObserver(()=>{
    augmentCards();
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
        (d.stops||[]).map((s,j)=>'stopIdx='+j+' "'+s.name+'"'+(s.time?' @'+s.time:'')+(s.duration?' ('+s.duration+')':'')).join(' | ')
      ).join('\n');
  }catch(e){ return ''; }
}

const _PLAN_SYS='You are an expert travel planning assistant embedded in a live itinerary app. You CAN make direct changes to the itinerary.\n\nThe full itinerary is already in this conversation. NEVER claim you cannot see it or ask the user to paste it.\n\nCRITICAL: Your prose alone does NOT change anything. A change is applied ONLY when you output an <ITINERARY_CHANGES> block. Never say a change was made unless that block is present in the same reply.\n\nWhen the user asks to add, remove, move, or modify anything: (1) confirm briefly in one sentence, (2) output an <ITINERARY_CHANGES>[ ...JSON array... ]</ITINERARY_CHANGES> block.\n\nEach JSON entry needs "action" and "description", plus:\n- update_stop: dayIdx, stopIdx, updates:{field:value}\n- add_stop: dayIdx, insertIdx(optional), stop:{name, type, time?, endTime?, duration?, notes?, lat?, lng?}\n- remove_stop: dayIdx, stopIdx\n- move_stop: fromDayIdx, fromStopIdx, toDayIdx, toStopIdx\n\nStop type is one of: hike, food, lodge, drive, flight, train, bus. Provide lat/lng for new places when you know them. Use the EXACT 0-based dayIdx/stopIdx from the LIVE ITINERARY index map. For pure questions/advice, answer normally with no block.';

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
    const display = text.replace(/<ITINERARY_CHANGES>[\s\S]*?<\/ITINERARY_CHANGES>/gi,'').trim();
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
      '<strong style="color:var(--pine)">'+(i+1)+'.</strong> '+_esc(c.description||c.action)+'</div>';
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

function _applyChanges(changes){
  let ok=0, fail=[];
  changes.forEach(c => {
    try{
      if(c.action==='update_stop'){
        const di=_rdi(c.dayIdx); const day=state.days[di];
        const si=_rsi(day,c.stopIdx);
        if(di<0||si<0||!day) throw new Error('index out of range');
        Object.assign(day.stops[si], c.updates||{});
        ok++;
      } else if(c.action==='add_stop'){
        const di=_rdi(c.dayIdx); const day=state.days[di];
        if(di<0||!day) throw new Error('day not found');
        const ins=c.insertIdx!=null ? Math.min(Math.max(0,c.insertIdx), day.stops.length) : day.stops.length;
        const ns=Object.assign({name:'New Stop',type:'hike',lat:0,lng:0}, c.stop||{});
        day.stops.splice(ins, 0, ns);
        ok++;
      } else if(c.action==='remove_stop'){
        const di=_rdi(c.dayIdx); const day=state.days[di];
        const si=_rsi(day,c.stopIdx);
        if(di<0||si<0||!day) throw new Error('index out of range');
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
  _syncOvernightArrivals();
  try{ saveState(); }catch(e){ console.warn('[trip-extras] saveState failed:', e); }
  try{ renderAll(); }catch(e){ console.warn('[trip-extras] renderAll failed:', e); }
  const msg = ok+' change'+(ok!==1?'s':'')+' applied'+(fail.length?' ('+fail.length+' failed)':'')+'!';
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
