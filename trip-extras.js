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
  const mo = document.getElementById('modal-overlay');
  if(mo) new MutationObserver(_injectFormField).observe(mo, {attributes:true, attributeFilter:['class']});
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', _startObserver);
else setTimeout(_startObserver, 0);


// ── 5.  AI CHAT — CHANGE-AWARE SYSTEM PROMPT + CONFIRMATION ──────────────
const _extHistory = [];  // conversation history maintained by our override

function _itinMap(){
  try{
    return '\n\nITINERARY (use exact 0-based indices in ITINERARY_CHANGES):\n'+
      (window.state.days||[]).map((d,i)=>
        'dayIdx='+i+' Day '+(i+1)+' "'+d.title+'": '+
        (d.stops||[]).map((s,j)=>'['+j+'] '+s.name+(s.time?' @'+s.time:'')).join(', ')
      ).join('\n');
  }catch(e){return '';}
}

const _PLAN_SYS='You are an expert travel planning assistant embedded in a live itinerary app. You can read AND make direct changes. When the user asks you to add, remove, move, or modify anything in the itinerary, explain briefly what you are doing AND include an <ITINERARY_CHANGES>[...JSON...]</ITINERARY_CHANGES> block. JSON array schema — each entry needs "action" and "description" plus: add_stop→{dayIdx,insertIdx?,stop:{name,type(hike|food|lodge|drive|flight|train|bus),notes?,time?,lat?,lng?}}; update_stop→{dayIdx,stopIdx,updates:{}}; remove_stop→{dayIdx,stopIdx}; move_stop→{fromDayIdx,fromStopIdx,toDayIdx,toStopIdx}. Use 0-based dayIdx/stopIdx from the itinerary map. For purely informational questions answer normally without a changes block. Be specific and concise. No em dashes.';

// Replace _planCallAI entirely — uses enhanced prompt, handles changes inline
const _origPcAdd = window._pcAddMessage;
window._planCallAI = async function(userText){
  _extHistory.push({role:'user',text:userText});
  const msgs=document.getElementById('pc-messages');
  const thk=document.createElement('div');
  thk.className='tg-msg tg-thinking';thk.textContent='Thinking…';
  if(msgs){msgs.appendChild(thk);msgs.scrollTop=msgs.scrollHeight;}
  try{
    const convo=_extHistory.map(m=>m.role+': '+m.text).join('\n\n');
    const text=await window.callClaude(_PLAN_SYS+_itinMap(),convo);
    if(thk.parentNode)thk.parentNode.removeChild(thk);
    const changeM=text.match(/<ITINERARY_CHANGES>([\s\S]*?)<\/ITINERARY_CHANGES>/i);
    const display=text.replace(/<ITINERARY_CHANGES>[\s\S]*?<\/ITINERARY_CHANGES>/gi,'').trim();
    _extHistory.push({role:'assistant',text:display||text});
    _origPcAdd.call(window,'assistant',display||text);
    if(changeM)_renderChangePanel(changeM[1]);
  }catch(e){
    if(thk.parentNode)thk.parentNode.removeChild(thk);
    _origPcAdd.call(window,'error','Could not reach the AI. Please try again.');
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

// Resolve dayIdx: accept 0-based; if out of range try 1-based correction
function _rdi(i){ const n=window.state.days.length; if(i>=0&&i<n)return i; if(i>0&&i<=n)return i-1; return -1; }
function _rsi(day,i){ const n=(day?.stops||[]).length; if(i>=0&&i<n)return i; if(i>0&&i<=n)return i-1; return -1; }

function _applyChanges(changes){
  let ok=0, fail=[];
  changes.forEach(c => {
    try{
      if(c.action==='update_stop'){
        const di=_rdi(c.dayIdx); const day=window.state.days[di];
        const si=_rsi(day,c.stopIdx);
        if(di<0||si<0||!day) throw new Error('index out of range');
        Object.assign(day.stops[si], c.updates||{});
        ok++;
      } else if(c.action==='add_stop'){
        const di=_rdi(c.dayIdx); const day=window.state.days[di];
        if(di<0||!day) throw new Error('day not found');
        const ins=c.insertIdx!=null ? Math.min(Math.max(0,c.insertIdx), day.stops.length) : day.stops.length;
        const ns=Object.assign({name:'New Stop',type:'hike',lat:0,lng:0}, c.stop||{});
        day.stops.splice(ins, 0, ns);
        ok++;
      } else if(c.action==='remove_stop'){
        const di=_rdi(c.dayIdx); const day=window.state.days[di];
        const si=_rsi(day,c.stopIdx);
        if(di<0||si<0||!day) throw new Error('index out of range');
        day.stops.splice(si,1);
        ok++;
      } else if(c.action==='move_stop'){
        const fdi=_rdi(c.fromDayIdx), tdi=_rdi(c.toDayIdx);
        const fday=window.state.days[fdi], tday=window.state.days[tdi];
        const fsi=_rsi(fday,c.fromStopIdx);
        if(fdi<0||tdi<0||fsi<0||!fday||!tday) throw new Error('index out of range');
        const [s]=fday.stops.splice(fsi,1);
        tday.stops.splice(Math.min(c.toStopIdx||0,tday.stops.length),0,s);
        ok++;
      }
    }catch(e){ fail.push(c.description||c.action); }
  });
  window.saveState();
  window.renderAll();
  const msg=ok+' change'+(ok!==1?'s':'')+' applied'+(fail.length?' ('+fail.length+' failed)':'')+'!';
  const toast=document.getElementById('share-toast');
  if(toast){ toast.textContent=msg; toast.classList.add('visible'); setTimeout(()=>toast.classList.remove('visible'),3500); }
}

// ✶ Request Changes button — fallback when AI gave advice without a change block
function _injectPlanChatBtn(){
  const content = document.getElementById('pc-content');
  if(!content || content.dataset.extBtn) return;
  const obs = new MutationObserver(()=>{
    const row = content.querySelector('.tg-input-row');
    if(!row || row.dataset.extBtnAdded) return;
    row.dataset.extBtnAdded='1';
    const btn = document.createElement('button');
    btn.textContent = '✶ Request Changes';
    btn.title = 'Convert AI advice into itinerary edits';
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
  if(!_extHistory.filter(m=>m.role==='assistant').length){
    alert('Chat with the AI first, then click this to turn its suggestions into edits.');
    return;
  }
  const msgs = document.getElementById('pc-messages');
  if(!msgs) return;
  const thk = document.createElement('div');
  thk.className='tg-msg tg-thinking'; thk.textContent='Generating change list…';
  msgs.appendChild(thk); msgs.scrollTop=msgs.scrollHeight;

  const ctx = _extHistory.map(m=>m.role+': '+m.text).join('\n\n');
  const sys = 'Based on the conversation, produce ONLY a <ITINERARY_CHANGES>[...JSON...]</ITINERARY_CHANGES> block. Each entry: action (update_stop|add_stop|remove_stop|move_stop), description, plus relevant fields (0-based dayIdx/stopIdx). add_stop needs stop{name,type,...}. update_stop needs updates{}. Output NOTHING outside the tags.'+_itinMap();

  try{
    const text = await window.callClaude(sys, ctx+'\n\nuser: List the itinerary changes you suggested as structured JSON.');
    if(thk.parentNode) thk.parentNode.removeChild(thk);
    const changeM = text.match(/<ITINERARY_CHANGES>([\s\S]*?)<\/ITINERARY_CHANGES>/i);
    if(changeM){ _renderChangePanel(changeM[1]); }
    else{
      const err=document.createElement('div');
      err.className='tg-msg tg-msg-err';
      err.textContent='Could not extract changes. Try asking the AI directly: "Add [X] to Day [N]".';
      msgs.appendChild(err); msgs.scrollTop=msgs.scrollHeight;
    }
  }catch(e){
    if(thk.parentNode) thk.parentNode.removeChild(thk);
  }
}

})();
