// trip-extras.js — end time, timezone labels, AI-itinerary edits with confirmation
(function(){
'use strict';

// ── helpers ────────────────────────────────────────────────────────────────
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
  const wasEditing = window.editingStop ? {dayIdx:window.editingStop.dayIdx, stopIdx:window.editingStop.stopIdx} : null;
  const addDay = window.addingToDay;
  const endTimeVal = (document.getElementById('f-endtime')||{}).value || '';

  _origSaveStop.apply(this, arguments);

  try{
    if(wasEditing != null){
      const s = window.state.days[wasEditing.dayIdx].stops[wasEditing.stopIdx];
      if(s){ if(endTimeVal) s.endTime=endTimeVal; else delete s.endTime; window.saveState(); }
    } else if(addDay != null){
      const day = window.state.days[addDay];
      if(day&&day.stops.length){
        const s = day.stops[day.stops.length-1];
        if(endTimeVal) s.endTime=endTimeVal; else delete s.endTime;
        window.saveState();
      }
    }
  }catch(e){}
};

// ── 3.  PATCH openEditStopModal TO PRE-FILL endTime ───────────────────────
const _origOpenEdit = window.openEditStopModal;
window.openEditStopModal = function(dayIdx, stopIdx){
  _origOpenEdit.apply(this, arguments);
  try{
    const s = window.state.days[dayIdx].stops[stopIdx];
    const el = document.getElementById('f-endtime');
    if(el) el.value = s.endTime || '';
  }catch(e){}
};

// ── 4.  AUGMENT CARDS WITH END TIME + TIMEZONE LABELS ─────────────────────
function _getPrevStop(dayIdx, stopIdx){
  try{
    const days = window.state.days;
    if(stopIdx > 0) return days[dayIdx].stops[stopIdx-1];
    if(dayIdx > 0){ const pd=days[dayIdx-1]; return pd.stops.length ? pd.stops[pd.stops.length-1] : null; }
  }catch(e){}
  return null;
}

function _tzOf(stop){ return (stop&&window.stopTz) ? window.stopTz(stop) : null; }

function augmentCards(){
  if(!window.state) return;
  document.querySelectorAll('.stop-card').forEach(card => {
    if(card.dataset.extAdded) return;
    card.dataset.extAdded = '1';
    const m = (card.id||'').match(/stop-card-(\d+)-(\d+)/);
    if(!m) return;
    const di=+m[1], si=+m[2];
    const stop = window.state?.days?.[di]?.stops?.[si];
    if(!stop) return;
    const timeEl = card.querySelector('.card-time');
    if(!timeEl || !stop.time) return;

    const isTransit = ['flight','train','bus','drive'].includes(stop.type);

    // For transit stops: start-time TZ = origin (previous stop's location)
    if(isTransit && stop.time){
      const prev = _getPrevStop(di, si);
      const oTz = _tzOf(prev);
      if(oTz){
        let tzSpan = timeEl.querySelector('.card-tz');
        if(!tzSpan){ tzSpan=document.createElement('span'); tzSpan.className='card-tz'; timeEl.appendChild(tzSpan); }
        tzSpan.textContent = oTz.abbr;
      }
    }

    // End time display with destination TZ
    if(stop.endTime){
      if(timeEl.querySelector('.card-endtime')) return; // already added
      const dTz = _tzOf(stop);
      const endEl = document.createElement('span');
      endEl.className = 'card-endtime';
      endEl.style.cssText = 'display:block;font-size:10px;font-weight:600;color:var(--muted);margin-top:3px;letter-spacing:0.02em;white-space:nowrap';
      endEl.innerHTML = '→ ' + _esc(stop.endTime) + (dTz ? ' <span style="font-size:9px;font-weight:700;letter-spacing:0.10em;color:var(--river);opacity:0.85">'+_esc(dTz.abbr)+'</span>' : '');
      timeEl.appendChild(endEl);
    }
  });
}

function _startObserver(){
  _injectFormField();
  augmentCards();
  const ca = document.getElementById('content-area');
  if(ca) new MutationObserver(augmentCards).observe(ca, {childList:true, subtree:true});
  // Also inject the form field when modals open (the modal overlay is shared)
  const mo = document.getElementById('modal-overlay');
  if(mo) new MutationObserver(_injectFormField).observe(mo, {attributes:true, attributeFilter:['class']});
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', _startObserver);
else setTimeout(_startObserver, 0);


// ── 5.  AI CHAT CHANGES WITH CONFIRMATION ─────────────────────────────────
const _extChat = [];  // local shadow of conversation for context

// Intercept _pcAddMessage to track conversation + detect <ITINERARY_CHANGES>
const _origPcAdd = window._pcAddMessage;
window._pcAddMessage = function(role, text){
  _extChat.push({role, text});
  if(role === 'assistant'){
    const changeM = text.match(/<ITINERARY_CHANGES>([\s\S]*?)<\/ITINERARY_CHANGES>/i);
    const displayText = text.replace(/<ITINERARY_CHANGES>[\s\S]*?<\/ITINERARY_CHANGES>/gi,'').trim();
    _origPcAdd.call(this, role, displayText || text);
    if(changeM) _renderChangePanel(changeM[1]);
  } else {
    _origPcAdd.apply(this, arguments);
  }
};

function _renderChangePanel(jsonStr){
  let changes;
  try{ changes = JSON.parse(jsonStr.trim()); }catch(e){ return; }
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

function _applyChanges(changes){
  let ok=0, fail=[];
  changes.forEach(c => {
    try{
      if(c.action==='update_stop'){
        Object.assign(window.state.days[c.dayIdx].stops[c.stopIdx], c.updates||{});
        ok++;
      } else if(c.action==='add_stop'){
        const day=window.state.days[c.dayIdx];
        day.stops.splice(c.insertIdx!=null?c.insertIdx:day.stops.length, 0, c.stop||{name:'New Stop',type:'hike'});
        ok++;
      } else if(c.action==='remove_stop'){
        window.state.days[c.dayIdx].stops.splice(c.stopIdx,1);
        ok++;
      } else if(c.action==='move_stop'){
        const [s]=window.state.days[c.fromDayIdx].stops.splice(c.fromStopIdx,1);
        window.state.days[c.toDayIdx].stops.splice(c.toStopIdx||0,0,s);
        ok++;
      }
    }catch(e){ fail.push(c.description||c.action); }
  });
  window.saveState();
  window.renderAll();
  const msg=ok+' change'+(ok!==1?'s':'')+' applied'+(fail.length?' ('+fail.length+' failed)':'')+'!';
  _origPcAdd.call(window,'assistant',msg);
  const toast=document.getElementById('share-toast');
  if(toast){ toast.textContent=msg; toast.classList.add('visible'); setTimeout(()=>toast.classList.remove('visible'),3000); }
}

// Inject "✦ Request Changes" button into the plan-chat modal
function _injectPlanChatBtn(){
  const content = document.getElementById('pc-content');
  if(!content || content.dataset.extBtn) return;
  const obs = new MutationObserver(()=>{
    const row = content.querySelector('.tg-input-row');
    if(!row || row.dataset.extBtnAdded) return;
    row.dataset.extBtnAdded='1';
    const btn = document.createElement('button');
    btn.textContent = '✶ Request Changes';
    btn.title = 'Ask AI to turn its suggestions into applied edits';
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
  if(!_extChat.filter(m=>m.role==='assistant').length){
    alert('Ask the AI for trip suggestions first, then click "Request Changes".');
    return;
  }
  const msgs = document.getElementById('pc-messages');
  if(!msgs) return;
  const thk = document.createElement('div');
  thk.className='tg-msg tg-thinking'; thk.textContent='Generating change list…';
  msgs.appendChild(thk); msgs.scrollTop=msgs.scrollHeight;

  const ctx = _extChat.map(m=>m.role+': '+m.text).join('\n\n');
  const sys = 'You are a travel-planning assistant. Based on the conversation, produce ONLY a <ITINERARY_CHANGES> block containing a JSON array. Each element must have: action (update_stop|add_stop|remove_stop|move_stop), description (human-readable string), and relevant index/data fields. update_stop requires dayIdx, stopIdx, updates{}. add_stop requires dayIdx, stop{}, optional insertIdx. remove_stop requires dayIdx, stopIdx. move_stop requires fromDayIdx, fromStopIdx, toDayIdx, toStopIdx. All indices are 0-based. Output NOTHING outside the XML tags.';

  try{
    const text = await window.callClaude(sys, ctx+'\n\nuser: List the itinerary changes you suggested as structured JSON.');
    if(thk.parentNode) thk.parentNode.removeChild(thk);
    const changeM = text.match(/<ITINERARY_CHANGES>([\s\S]*?)<\/ITINERARY_CHANGES>/i);
    if(changeM){ _renderChangePanel(changeM[1]); }
    else{
      const err=document.createElement('div');
      err.className='tg-msg tg-msg-err';
      err.textContent='No changes found. Ask the AI to suggest specific modifications (add, remove, move stops or change times) before requesting changes.';
      msgs.appendChild(err); msgs.scrollTop=msgs.scrollHeight;
    }
  }catch(e){
    if(thk.parentNode) thk.parentNode.removeChild(thk);
  }
}

})();
