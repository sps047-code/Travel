// The version of the CODE actually running. The header badge reads this (not the
// service-worker cache name), so a stale build can never masquerade as a new one.
// Bump this together with the CACHE in sw.js on every deploy.
window.APP_CODE_VERSION='v163';
try{var _vEl=document.getElementById('app-version');if(_vEl)_vEl.textContent=window.APP_CODE_VERSION;}catch(e){}
const tripId=new URLSearchParams(location.search).get('id')||'utah';
const LS_KEY='tripState_'+tripId;
const PACK_KEY='seasons_packing_'+tripId;
const PROXY_URL='https://travel-ai-proxy.sps047.workers.dev';
function lsPack(val){
  if(val===undefined){try{return JSON.parse(localStorage.getItem(PACK_KEY)||'null')}catch(e){return null}}
  try{localStorage.setItem(PACK_KEY,JSON.stringify(val))}catch(e){}
}
/* ---- Firebase config (Family trip sync) ---- */
// SECURITY: this Realtime Database is used over plain REST with NO authentication.
// Anyone who reads this file can read AND write every trip, plus presence data.
// Before sharing more widely, database security rules restricting reads/writes are
// required. Corollary: per-trip secrets must NEVER be stored in synced `state` —
// it is world-readable (see _gpKey, which keeps the Places key device-local).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC344fuoqnXG5RWN3hNMkCkr9GoHk6dozY",
  authDomain: "seasons-trips.firebaseapp.com",
  databaseURL: "https://seasons-trips-default-rtdb.firebaseio.com",
  projectId: "seasons-trips",
  storageBucket: "seasons-trips.firebasestorage.app",
  messagingSenderId: "33886419285",
  appId: "1:33886419285:web:22628c2508855318dc57dc"
};

let state,currentDayIdx=0,addingToDay=0,editingStop=null;
let _optDayIdx=-1,_optLastData=null,_lastUndoFn=null,_optUndoTimer=null;
let _altDayIdx=-1,_altStopIdx=-1,_altResults=[];
let _dragDayFrom=-1;
// localOnly=true persists to this device but does NOT push to the shared cloud.
// Use it for MACHINE-generated mutations (auto opening-hours, overnight-arrival
// sync, one-time migrations) so they can never out-race and clobber a real human
// edit from another device/tab under last-writer-wins. Those values are derived
// and each device recomputes them anyway.
// Baseline of physical-logic errors already present in the last persisted state.
// A save is blocked only if it ADDS a NEW impossibility — so a pre-existing issue
// can never trap you, but no NEW garbage is ever written. Seeded on load.
let _baselineErrKeys=null;
function _seedLogicBaseline(){ try{ _baselineErrKeys=new Set(_logicErrors(state).map(_errKey)); }catch(e){ _baselineErrKeys=new Set(); } }
function saveState(changeDesc='',localOnly=false){
  if(IS_READONLY)return; // a read-only viewer must never persist or push changes
  // ---- PHYSICAL-LOGIC GATE: never write an itinerary that adds an impossibility.
  try{
    if(_baselineErrKeys===null)_seedLogicBaseline();
    let errs=_logicErrors(state);
    let added=errs.filter(e=>!_baselineErrKeys.has(_errKey(e)));
    if(added.length){
      // First TRY to make it fit by shrinking visit durations (not refusing).
      const snap=JSON.stringify(state);
      const changed=_relaxDurationsToFit(state);
      errs=_logicErrors(state);
      added=errs.filter(e=>!_baselineErrKeys.has(_errKey(e)));
      if(added.length){
        // Still impossible even after shrinking visits to zero → refuse; roll back
        // the shrink so we don't leave half-adjusted durations.
        try{state=JSON.parse(snap);}catch(e){}
        _showLogicError(added);
        return;
      }
      if(changed.length)_showDurationAdjustWarning(changed); // fit by trimming — warn only
    }
    _baselineErrKeys=new Set(errs.map(_errKey)); // (possibly-adjusted) save becomes the new baseline
  }catch(e){ /* the gate must never itself break saving */ }
  try{localStorage.setItem(LS_KEY,JSON.stringify(state))}catch(e){}
  if(!localOnly && getTripType()==='family')_syncFamily(changeDesc);
}

// ---- DATA-LOSS SAFEGUARDS (added after the June-14 overwrite incident) ------
// Count every stop across all days in a trip state.
function _countStops(st){ try{ return (st.days||[]).reduce((n,d)=>n+((d.stops||[]).length),0); }catch(e){ return 0; } }
// Would writing `next` over `prev` destroy a lot of real work? Used as a brake so
// a stale, empty, or default copy can never silently clobber a full itinerary.
// A deliberate restore passes force and bypasses this.
function _wouldLoseData(prev,next){
  if(!prev||!Array.isArray(prev.days)||!prev.days.length)return false; // nothing to lose
  if(!next||!Array.isArray(next.days)||!next.days.length)return true;  // next isn't a real trip
  const ps=_countStops(prev), ns=_countStops(next);
  // NOTE: deleting a day is a legitimate edit, so day-count alone must NOT block a
  // push — that rule silently froze syncing for good. Only catastrophic loss blocks.
  if(ps>=6 && ns < ps*0.5)return true;                  // loses more than half the stops
  return false;
}
// How many versions to always keep in the cloud, and how often a new one is
// taken. Backups are WEEKLY: a new version is banked only if the newest existing
// one is at least a week old, and the oldest are dropped so BACKUP_KEEP remain
// (so ~5 weeks of history).
const BACKUP_KEEP=5;
const BACKUP_INTERVAL_MS=7*24*60*60*1000; // weekly
// Is a new backup due? True if there is none yet, or the newest is >= a week old.
function _isBackupDue(newestAt,now){
  if(!newestAt)return true;
  return (now-newestAt)>=BACKUP_INTERVAL_MS;
}
// CLOUD version history: once a week, snapshot the current shared copy into
// /history, then trim so only the newest BACKUP_KEEP versions are kept. Stored in
// the shared cloud (NOT on the device), so the versions are available from any
// device and survive losing a phone.
async function _dbBackupBeforeOverwrite(priorState,ts,desc){
  if(!priorState||!_validTripState(priorState))return;
  try{
    const r=await fetch(_familyBase()+'/history.json?nc='+Date.now(),{cache:'no-store'});
    const hist=await r.json();
    let keys=(hist&&typeof hist==='object')?Object.keys(hist).sort((a,b)=>Number(a)-Number(b)):[]; // oldest first
    // Weekly cadence: skip if we already banked a version within the last week.
    if(keys.length){
      const nk=keys[keys.length-1];
      const newestAt=(hist[nk]&&hist[nk].at)||Number(nk);
      if(!_isBackupDue(newestAt,ts))return;
    }
    await _dbFamilyPut('/history/'+ts,{at:ts,by:_sessionId(),desc:desc||'',state:priorState});
    keys.push(String(ts));
    for(let i=0;i<keys.length-BACKUP_KEEP;i++){ try{ await _dbFamilyDelete('/history/'+keys[i]); }catch(e){} }
  }catch(e){}
}
// Accept an incoming (cloud) state only if it is structurally a trip and would
// not wipe a non-empty local itinerary with an empty one.
function _validTripState(st){
  if(!st||typeof st!=='object'||!Array.isArray(st.days))return false;
  if(st.days.length===0 && typeof state!=='undefined' && state && Array.isArray(state.days) && state.days.length>0)return false;
  return true;
}

const map=L.map('map',{zoomControl:true,center:[39,-98],zoom:4});
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',maxZoom:19}).addTo(map);
let markersLayer=L.layerGroup().addTo(map),routeLayer=L.layerGroup().addTo(map),routeCache={};
const TC={hike:"#C23B3B",food:"#C47B20",lodge:"#2E7D52",drive:"#2B6CB0",flight:"#7B5EA7",train:"#4A6572",bus:"#1D4E73"};

/* ---- Photo upload helpers ---- */
let pendingPhoto=null; // null=no change, dataURL=new image
let pendingTicket=null; // null=no change, dataURL=new ticket, ''=cleared
let pendingTicketName=''; // original filename for non-image files
let pendingDesc=null;  // null=no change, string=new/updated desc, ''=cleared
function showPhotoPreview(src){
  const area=document.getElementById('photo-upload-area');
  const preview=document.getElementById('f-photo-preview');
  const placeholder=document.getElementById('photo-placeholder');
  const removeBtn=document.getElementById('photo-remove-btn');
  if(src){
    preview.src=src;preview.style.display='block';
    placeholder.style.display='none';area.classList.add('has-photo');
    removeBtn.style.display='block';
  }else{
    preview.style.display='none';placeholder.style.display='block';
    area.classList.remove('has-photo');removeBtn.style.display='none';
  }
}
function removePhoto(e){if(e)e.stopPropagation();pendingPhoto='';showPhotoPreview(null);document.getElementById('f-photo').value='';}
async function handlePhotoUpload(input){
  const file=input.files[0];if(!file)return;
  // Without these guards a non-image (or an unreadable/corrupt file) left the
  // promise pending forever and the UI hung with no error.
  if(!file.type||!file.type.startsWith('image/')){alert('Please choose an image file.');input.value='';return;}
  const dataUrl=await new Promise(resolve=>{
    const reader=new FileReader();
    reader.onerror=()=>resolve(null);
    reader.onload=e=>{
      const img=new Image();
      img.onerror=()=>resolve(null);
      img.onload=()=>{
        const scale=Math.min(1,500/img.width);
        const canvas=document.createElement('canvas');
        canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        resolve(canvas.toDataURL('image/jpeg',0.80));
      };
      img.src=e.target.result;
    };
    reader.readAsDataURL(file);
  });
  // A null result means the file could not be read or decoded — tell the user
  // rather than silently clearing an existing photo.
  if(!dataUrl){alert('That image could not be read. Please try another file.');input.value='';return;}
  pendingPhoto=dataUrl;showPhotoPreview(dataUrl);
}

/* ---- Ticket upload helpers ---- */
function showTicketPreview(src,name,isImage){
  const area=document.getElementById('ticket-upload-area');
  const preview=document.getElementById('f-ticket-preview');
  const placeholder=document.getElementById('ticket-placeholder');
  const removeBtn=document.getElementById('ticket-remove-btn');
  if(!area)return;
  if(src){
    if(isImage===false){
      preview.removeAttribute('src');preview.style.display='none';
      placeholder.innerHTML='&#127903; '+((name||'').replace(/</g,'&lt;').slice(0,40)||'File uploaded');
      placeholder.style.display='block';
    }else{
      preview.src=src;preview.style.display='block';
      placeholder.style.display='none';
    }
    area.classList.add('has-photo');removeBtn.style.display='block';
  }else{
    preview.style.display='none';
    placeholder.innerHTML='&#127903; Click to upload a ticket or pass';
    placeholder.style.display='block';
    area.classList.remove('has-photo');removeBtn.style.display='none';
  }
}
function removeTicket(e){if(e)e.stopPropagation();pendingTicket='';pendingTicketName='';showTicketPreview(null);const fi=document.getElementById('f-ticket');if(fi)fi.value='';}
async function handleTicketUpload(input){
  const file=input.files[0];if(!file)return;
  const isImage=file.type.startsWith('image/');
  const dataUrl=await new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=reject;
    if(isImage){
      reader.onload=e=>{
        const img=new Image();
        img.onload=()=>{
          const scale=Math.min(1,1200/img.width);
          const canvas=document.createElement('canvas');
          canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);
          canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
          resolve(canvas.toDataURL('image/jpeg',0.85));
        };
        img.src=e.target.result;
      };
      reader.readAsDataURL(file);
    }else{
      reader.onload=e=>resolve(e.target.result);
      reader.readAsDataURL(file);
    }
  });
  pendingTicket=dataUrl;
  pendingTicketName=isImage?'':file.name;
  showTicketPreview(dataUrl,file.name,isImage);
  _extractTicketReservation(dataUrl,file.type);
}
async function _extractTicketReservation(dataUrl,mimeType){
  const resField=document.getElementById('f-reservation');
  if(!resField||resField.value.trim())return;
  const mime=mimeType||(dataUrl.match(/^data:([^;]+)/)||[])[1]||'';
  if(!mime.startsWith('image/')&&mime!=='application/pdf')return;
  try{
    const base64=dataUrl.split(',')[1];
    const contentBlock=mime==='application/pdf'
      ?{type:'document',source:{type:'base64',media_type:'application/pdf',data:base64}}
      :{type:'image',source:{type:'base64',media_type:'image/jpeg',data:base64}};
    const res=await fetch(PROXY_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        system:'You are a ticket reader. Extract the booking/confirmation/reservation reference number from this ticket or pass. Return ONLY the code itself (e.g. "ABC123" or "XY-789456") with no other text. If none found, return empty string.',
        messages:[{role:'user',content:[
          contentBlock,
          {type:'text',text:'What is the booking or confirmation number on this ticket?'}
        ]}]
      })
    });
    if(!res.ok)return;
    const data=await res.json();
    const code=(data.content?.[0]?.text||'').trim();
    if(code&&code.length>2&&code.length<40&&!/^(none|n\/a|not found|no)/i.test(code)){
      resField.value=code;
    }
  }catch(e){}
}
function showTicketViewer(di,si){
  const s=state.days[di].stops[si];if(!s||!s.ticketImage)return;
  const mime=(s.ticketImage.match(/^data:([^;]+)/)||[])[1]||'';
  if(!mime.startsWith('image/')){
    // Use Blob URL + window.open — works on iOS; a.click() download doesn't
    try{
      const b64=s.ticketImage.split(',')[1];
      const bytes=atob(b64);const arr=new Uint8Array(bytes.length);
      for(let i=0;i<bytes.length;i++)arr[i]=bytes.charCodeAt(i);
      const blob=new Blob([arr],{type:mime});
      const url=URL.createObjectURL(blob);
      const win=window.open(url,'_blank');
      setTimeout(()=>URL.revokeObjectURL(url),60000);
      if(!win){// popup blocked — fall back to link click
        const a=document.createElement('a');a.href=url;a.download=s.ticketFileName||'ticket';
        document.body.appendChild(a);a.click();document.body.removeChild(a);
      }
    }catch(e){
      const a=document.createElement('a');a.href=s.ticketImage;
      a.download=s.ticketFileName||'ticket';document.body.appendChild(a);a.click();document.body.removeChild(a);
    }
    return;
  }
  document.getElementById('ticket-viewer-img').src=s.ticketImage;
  document.getElementById('ticket-viewer').style.display='flex';
}
function closeTicketViewer(){
  document.getElementById('ticket-viewer').style.display='none';
  document.getElementById('ticket-viewer-img').src='';
}

async function generateModalDesc(){
  const btn=document.getElementById('f-desc-btn');
  const display=document.getElementById('f-desc-display');
  if(!btn||!display)return;
  const name=document.getElementById('f-name').value.trim();
  if(!name){alert('Please enter a stop name first.');return;}
  btn.disabled=true;btn.textContent='Generating…';display.textContent='';
  try{
    const type=document.getElementById('f-type').value;
    const notes=document.getElementById('f-notes').value.trim();
    const lat=parseFloat(document.getElementById('f-lat').value);
    const lng=parseFloat(document.getElementById('f-lng').value);
    const parts=[name,'Type: '+type];
    if(notes)parts.push('Notes: '+notes);
    if(!isNaN(lat)&&!isNaN(lng))parts.push('Coordinates: '+lat.toFixed(3)+', '+lng.toFixed(3));
    const text=await callClaude(DESC_SYSTEM,parts.join('\n'));
    pendingDesc=text.trim();
    display.textContent=pendingDesc;
    btn.textContent='✨ Regenerate Description';btn.disabled=false;
  }catch(e){
    display.textContent='Could not generate — try again.';
    btn.textContent='✨ Generate Description';btn.disabled=false;
  }
}

/* ---- Timezone support ---- */
const TZ_LS='tz_cache_v1';
let tzData={};
try{tzData=JSON.parse(localStorage.getItem(TZ_LS)||'{}')}catch(e){}
function tzKey(lat,lng){return(+lat).toFixed(1)+','+(+lng).toFixed(1)}
function tzAbbr(ianaZone){
  try{return new Intl.DateTimeFormat('en-US',{timeZone:ianaZone,timeZoneName:'short'}).formatToParts(new Date()).find(p=>p.type==='timeZoneName')?.value||''}catch(e){return''}
}
async function getTimezone(lat,lng){
  const k=tzKey(lat,lng);
  if(tzData[k])return tzData[k];
  try{
    const r=await fetch('https://api.bigdatacloud.net/data/timezone-by-location?latitude='+lat+'&longitude='+lng);
    if(!r.ok)return null;
    const d=await r.json();
    if(!d.timeZone)return null;
    const result={tz:d.timeZone,abbr:tzAbbr(d.timeZone)};
    tzData[k]=result;
    try{localStorage.setItem(TZ_LS,JSON.stringify(tzData))}catch(e){}
    return result;
  }catch(e){return null}
}
async function loadTimezones(){
  const stops=state.days.flatMap(d=>d.stops).filter(s=>s.lat&&s.lng);
  const unique=[...new Map(stops.map(s=>[tzKey(s.lat,s.lng),s])).values()];
  await Promise.all(unique.map(s=>getTimezone(s.lat,s.lng)));
  renderAll();
}
function stopTz(s){return s.lat&&s.lng?tzData[tzKey(s.lat,s.lng)]:null}
function tzChangeLabel(a,b){
  const ta=stopTz(a),tb=stopTz(b);
  if(!ta||!tb||ta.tz===tb.tz)return'';
  return(ta.abbr||ta.tz.split('/').pop())+' → '+(tb.abbr||tb.tz.split('/').pop());
}

function haversine(la1,lo1,la2,lo2){
  const R=3959,r=Math.PI/180;
  const dLa=(la2-la1)*r,dLo=(lo2-lo1)*r;
  const a=Math.sin(dLa/2)**2+Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dLo/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function _travelMins(straightLineMiles,mode){
  if(mode==='flight')return Math.round(straightLineMiles/8);
  if(mode==='train')return Math.round(straightLineMiles/0.85);
  if(mode==='bus')return Math.round(straightLineMiles/0.5);
  if(mode==='bike')return Math.round(straightLineMiles/0.2);   // ~12 mph
  if(mode==='walk')return Math.round(straightLineMiles/0.05);
  // drive: apply 1.25 road-overhead factor then adaptive mph
  const road=straightLineMiles*1.25;
  const mph=road>120?65:road>40?55:road>10?40:20;
  return Math.round(road/mph*60);
}
function _minsToStr(mins){
  return mins<60?mins+' min':(Math.floor(mins/60)+'h'+(mins%60?' '+(mins%60)+'min':''));
}
// ---- Airport arrival: be there 3 hrs early for international, 2 hrs domestic ---
// Format minutes-since-midnight as a clock time (wraps within a day).
function _minsToClock(mins){
  mins=((Math.round(mins)%1440)+1440)%1440;
  const h=Math.floor(mins/60), mn=mins%60, ap=h<12?'AM':'PM'; let h12=h%12; if(h12===0)h12=12;
  return h12+':'+(mn<10?'0':'')+mn+' '+ap;
}
// Is a flight international? An explicit choice (stop.international) always wins.
// Otherwise guess: long-haul by distance (if destination coords are known), or an
// international signal in the flight's text (transatlantic, international, etc.) —
// needed because many flights store no destination coordinates.
function _isIntlFlight(s){
  if(s&&typeof s.international==='boolean')return s.international;
  if(s&&_validLL(s)&&s.destLat&&s.destLng&&_validLL({lat:s.destLat,lng:s.destLng})){
    try{ if(haversine(s.lat,s.lng,s.destLat,s.destLng)>1500)return true; }catch(e){}
  }
  const txt=(((s&&s.name)||'')+' '+((s&&s.from)||'')+' '+((s&&s.to)||'')+' '+((s&&s.notes)||'')).toLowerCase();
  if(/transatlantic|transpacific|international|\bintl\b|overseas|long.?haul/.test(txt))return true;
  return false;
}
// Minutes you should be at the airport before departure: 180 intl, 120 domestic.
function _airportBufferMin(s){ return _isIntlFlight(s)?180:120; }
// The "be at the airport by" chip shown on a flight card (styled to stand out).
// The REAL scheduled departure of a flight. This is NOT the same as s.time,
// because _recalcDayTimes overwrites a flight's start time with the cumulative
// arrival-at-airport time. Priority: the preserved departure the user entered
// (s.flightDepart), then a "Departs ... 8:30 PM" time in the notes, then s.time.
function _clockIn(str){
  let d=_parseTimeMins(str);
  if(d!=null)return d;
  const m=String(str||'').match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
  return m?_parseTimeMins((m[1]+' '+(m[2]||'')).trim()):null;
}
function _flightDepMins(s){
  if(!s)return null;
  let d=_clockIn(s.flightDepart);
  if(d!=null)return d;
  const n=String(s.notes||'').match(/depart\w*[^0-9]{0,14}(\d{1,2}:\d{2})\s*(am|pm)?/i);
  if(n){ d=_parseTimeMins((n[1]+' '+(n[2]||'')).trim()); if(d!=null)return d; }
  return _clockIn(s.time);
}
function _airportArrivalHtml(s){
  if(!s||s.type!=='flight')return '';   // shown on flights only
  const intl=_isIntlFlight(s), buf=intl?180:120;
  const dep=_flightDepMins(s);
  let body;
  if(dep==null){
    // No readable departure time — still show the rule so a flight always tells
    // the traveler how early to arrive.
    body='&#128747; Arrive '+(intl?'3 hrs':'2 hrs')+' early '+(intl?'(international)':'(domestic)')+' &mdash; add the flight’s start time to see the exact airport time';
  }else{
    let at=dep-buf, note='';
    if(at<0){ at+=1440; note=' (the night before)'; }
    body='&#128747; Be at the airport by '+_escHtml(_minsToClock(at))+note+'<span style="font-weight:500;opacity:0.85"> &mdash; '+(intl?'3 hrs before (international)':'2 hrs before (domestic)')+'</span>';
  }
  return '<div style="margin-top:7px;display:inline-block;background:rgba(46,125,82,0.10);border:1px solid rgba(46,125,82,0.32);color:var(--pine);border-radius:9px;padding:6px 11px;font-size:12.5px;font-weight:700;line-height:1.35">'+body+'</div>';
}
// Will the plan actually get the traveler to the airport early enough? Compares
// when they'd ARRIVE at the airport (previous stop's departure + travel there)
// against when they MUST be there (flight departure − 3h intl / 2h domestic).
// Returns {ok, dep, mustBeBy, arrival, latestLeave, travel, prevName} or null.
function _airportFeasibility(prev,s){
  if(!s||s.type!=='flight')return null;
  const dep=_flightDepMins(s);
  if(dep==null||!prev)return null;
  const ps=_parseTimeMins(prev.time),pe=_parseTimeMins(prev.endTime);
  if(ps==null)return null;
  const prevDepart=(pe!=null&&pe>ps)?pe:ps+_stopVisitMins(prev);
  const travel=_legTravelMins(prev,s);
  if(!(travel>0))return null;
  const buffer=_airportBufferMin(s);
  const mustBeBy=dep-buffer;
  const arrival=prevDepart+travel;
  return {ok:arrival<=mustBeBy,dep:dep,mustBeBy:mustBeBy,arrival:arrival,latestLeave:mustBeBy-travel,travel:travel,prevName:prev.name||'the previous stop',intl:_isIntlFlight(s)};
}
// The red warning chip shown on a flight when the plan won't reach the airport
// early enough. Returns '' when the flight is fine (or can't be evaluated).
function _airportWarningHtml(prev,s){
  const f=_airportFeasibility(prev,s);
  if(!f||f.ok)return '';
  const leave=f.latestLeave;
  const leaveTxt=leave<0?'earlier in the day':('by '+_minsToClock(leave));
  return '<div style="margin-top:7px;display:block;background:rgba(194,59,59,0.10);border:1px solid rgba(194,59,59,0.40);color:var(--ruby,#c23b3b);border-radius:9px;padding:7px 11px;font-size:12.5px;font-weight:700;line-height:1.4">&#9888;&#65039; You won’t reach the airport '+(f.intl?'3 hours':'2 hours')+' before your '+_escHtml(_minsToClock(f.dep))+' flight. To make it, leave '+_escHtml(f.prevName)+' '+_escHtml(leaveTxt)+' (it’s about '+_minsToStr(f.travel)+' to the airport).</div>';
}
function legLabel(a,b,mode){
  if(!_validLL(a)||!_validLL(b))return'';
  const dist=haversine(a.lat,a.lng,b.lat,b.lng);
  if(dist<0.05)return'';
  const mi=dist<10?dist.toFixed(1):Math.round(dist);
  const mins=_travelMins(dist,mode);
  return mi+' mi · '+_minsToStr(mins);
}
// Valid usable coordinates. Treats 0,0 (a real point off West Africa that stops
// default to when a location is unknown) as missing, matching the old !lat check.
function _validLL(s){return !!(s&&s.lat&&s.lng&&Math.abs(s.lat)<=90&&Math.abs(s.lng)<=180);}
// Nearest stop (searching in `dir`) that has usable coordinates, starting at idx.
function _legEndpoint(stops,idx,dir){
  for(let i=idx;i>=0&&i<stops.length;i+=dir){ if(_validLL(stops[i]))return stops[i]; }
  return null;
}

function makeIcon(num,color,isAlt){
  const op=isAlt?0.6:1;
  return L.divIcon({html:`<svg xmlns="http://www.w3.org/2000/svg" width="30" height="36" viewBox="0 0 30 36"><path d="M15 0C7.268 0 1 6.268 1 14c0 8.836 14 22 14 22S29 22.836 29 14C29 6.268 22.732 0 15 0z" fill="${color}" fill-opacity="${op}" stroke="white" stroke-width="1.5"/><text x="15" y="16" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="11" font-weight="800" font-family="sans-serif">${num}</text></svg>`,className:'',iconSize:[30,36],iconAnchor:[15,36],popupAnchor:[0,-38]});
}

function greatCirclePoints(p1,p2,steps=80){
  const toR=d=>d*Math.PI/180,toD=r=>r*180/Math.PI;
  const la1=toR(p1[0]),lo1=toR(p1[1]),la2=toR(p2[0]),lo2=toR(p2[1]);
  const pts=[];
  for(let i=0;i<=steps;i++){
    const f=i/steps;
    const d=2*Math.asin(Math.sqrt(Math.sin((la2-la1)/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin((lo2-lo1)/2)**2));
    if(d<0.0001){pts.push([toD(la1),toD(lo1)]);continue;}
    const A=Math.sin((1-f)*d)/Math.sin(d),B=Math.sin(f*d)/Math.sin(d);
    const x=A*Math.cos(la1)*Math.cos(lo1)+B*Math.cos(la2)*Math.cos(lo2);
    const y=A*Math.cos(la1)*Math.sin(lo1)+B*Math.cos(la2)*Math.sin(lo2);
    const z=A*Math.sin(la1)+B*Math.sin(la2);
    pts.push([toD(Math.atan2(z,Math.sqrt(x*x+y*y))),toD(Math.atan2(y,x))]);
  }
  return pts;
}

function _median(nums){
  const a=[...nums].sort((x,y)=>x-y);const n=a.length;
  return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):0;
}
// Drop stops whose coordinates are a wild outlier from the day's cluster. A bad
// geocode (e.g. a London day with one point mislocated to Spain) must never warp
// the driving route or make the map claim you are going somewhere you are not.
const _ROUTE_OUTLIER_MI=500;
function _dropCoordOutliers(stops){
  const withCoord=stops.filter(s=>s.lat&&s.lng);
  if(withCoord.length<3)return stops; // too few points to judge an outlier
  const medLat=_median(withCoord.map(s=>s.lat)),medLng=_median(withCoord.map(s=>s.lng));
  return stops.filter(s=>!s.lat||!s.lng||haversine(medLat,medLng,s.lat,s.lng)<=_ROUTE_OUTLIER_MI);
}
async function fetchRoute(stops){
  let rs=stops.filter(s=>!s.alt&&s.lat&&s.lng&&s.type!=='flight');
  rs=_dropCoordOutliers(rs);
  if(rs.length<2)return null;
  const key=rs.map(s=>s.lat+','+s.lng).join('|');
  if(routeCache[key])return routeCache[key];
  try{
    const url='https://router.project-osrm.org/route/v1/driving/'+rs.map(s=>s.lng+','+s.lat).join(';')+'?overview=full&geometries=geojson';
    const r=await fetch(url);if(!r.ok)throw 0;
    const d=await r.json();if(d.code!=='Ok')throw 0;
    routeCache[key]=d.routes[0].geometry.coordinates;return routeCache[key];
  }catch(e){return null}
}

let _mapGen=0;
async function renderDayMap(idx,fit=true){
  // GENERATION GUARD. Two concurrent renderDayMap calls each cleared the layers
  // and then independently awaited fetchRoute, so BOTH added a route polyline —
  // stacked lines and doubled OSRM calls. Only the newest call may touch layers.
  const gen=++_mapGen;
  markersLayer.clearLayers();routeLayer.clearLayers();
  const day=state.days[idx];if(!day)return;
  const st=document.getElementById('route-status');
  st.style.display='block';st.textContent='Loading driving routes...';
  const bounds=[];
  // include the hotel you wake up at as the route origin (same logic as the bookend)
  const TRANSIT=['flight','train','bus'];
  const prevDay=idx>0?state.days[idx-1]:null;
  const prevLast=prevDay&&prevDay.stops.length?prevDay.stops[prevDay.stops.length-1]:null;
  const prevEndsInTransit=prevLast&&TRANSIT.includes(prevLast.type);
  let startHotel=(!prevEndsInTransit&&day.stops.length>0)?getHotelForDay(idx-1):null;
  if(startHotel&&(!startHotel.lat||!startHotel.lng))startHotel=null;
  // skip if the day's first stop already is that hotel
  if(startHotel&&day.stops[0]&&day.stops[0].lat===startHotel.lat&&day.stops[0].lng===startHotel.lng)startHotel=null;
  if(startHotel){
    const nm=startHotel.name.replace(/^check.?in\s*[—–\-]\s*/i,'').replace(/\s*[—–].*/,'').trim();
    const hm=L.marker([startHotel.lat,startHotel.lng],{icon:L.divIcon({html:'<div style="background:#2E7D52;color:white;border:2px solid white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 1px 4px rgba(0,0,0,0.4)">&#127970;</div>',className:'',iconSize:[28,28],iconAnchor:[14,14]})});
    hm.bindPopup('<div style="font-weight:700;font-size:13px">Starting from: '+_escHtml(nm)+'</div>',{maxWidth:200});
    markersLayer.addLayer(hm);bounds.push([startHotel.lat,startHotel.lng]);
  }
  // include tonight's hotel as the route DESTINATION (mirror of the start hotel)
  const todayLast=day.stops.length?day.stops[day.stops.length-1]:null;
  const todayEndsInTransit=todayLast&&TRANSIT.includes(todayLast.type);
  let endHotel=(!todayEndsInTransit&&day.stops.length>0)?getNextHotelForDay(idx):null;
  if(endHotel&&(!endHotel.lat||!endHotel.lng))endHotel=null;
  // skip if the day's last stop already IS that hotel (route already ends there)
  if(endHotel&&todayLast&&todayLast.lat===endHotel.lat&&todayLast.lng===endHotel.lng)endHotel=null;
  // getNextHotelForDay returns null on the FINAL day ("heading home"). But a day
  // that starts from a base hotel and ends with sightseeing (not a flight/train
  // out) returns to that SAME hotel that night — so close the route back to the
  // start hotel. This is the round-trip case (e.g. day-tripping from Edinburgh).
  if(!endHotel&&startHotel&&!todayEndsInTransit&&day.stops.length>0
     &&!(todayLast&&todayLast.lat===startHotel.lat&&todayLast.lng===startHotel.lng)){
    endHotel=startHotel;
  }
  day.stops.forEach((s,i)=>{
    if(!s.lat||!s.lng)return;
    const m=L.marker([s.lat,s.lng],{icon:makeIcon(i+1,TC[s.type]||'#8B7355',s.alt)});
    m.bindPopup('<div style="font-weight:700;font-size:13px">'+_escHtml(s.name)+'</div>'+(s.alt?'<div style="font-size:11px;color:#5555BB;margin-top:3px">Alternate option</div>':''),{maxWidth:200});
    markersLayer.addLayer(m);bounds.push([s.lat,s.lng]);
  });
  // End-hotel marker. If tonight's hotel is the same place you started from
  // (a round trip), don't stack a second marker on it — the route still closes
  // back to it below.
  const _endSameAsStart=startHotel&&endHotel&&startHotel.lat===endHotel.lat&&startHotel.lng===endHotel.lng;
  if(endHotel&&!_endSameAsStart){
    const enm=endHotel.name.replace(/^check.?in\s*[—–\-]\s*/i,'').replace(/\s*[—–].*/,'').trim();
    const ehm=L.marker([endHotel.lat,endHotel.lng],{icon:L.divIcon({html:'<div style="background:#2E7D52;color:white;border:2px solid white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 1px 4px rgba(0,0,0,0.4)">&#127976;</div>',className:'',iconSize:[28,28],iconAnchor:[14,14]})});
    ehm.bindPopup('<div style="font-weight:700;font-size:13px">Tonight: '+_escHtml(enm)+'</div>',{maxWidth:200});
    markersLayer.addLayer(ehm);bounds.push([endHotel.lat,endHotel.lng]);
  }
  if(fit&&bounds.length)map.fitBounds(bounds,{padding:[40,40]});
  for(let i=0;i<day.stops.length-1;i++){
    const a=day.stops[i],b=day.stops[i+1];
    if(a.type==='flight'&&a.lat&&b.lat){
      L.polyline(greatCirclePoints([a.lat,a.lng],[b.lat,b.lng]),{color:'#4A7EC7',weight:2.5,opacity:0.8,dashArray:'8,5'}).addTo(routeLayer);
    }
  }
  let routeStops=startHotel?[startHotel,...day.stops]:day.stops.slice();
  if(endHotel)routeStops=[...routeStops,endHotel];   // the road route ends at tonight's hotel
  // Draw a solid straight connector FIRST so a line is always visible even if the
  // routing service is slow or down. When the road route comes back it's drawn on
  // top and becomes the line you see. No dashed lines.
  const straight=_dropCoordOutliers(routeStops.filter(s=>!s.alt&&s.lat&&s.lng&&s.type!=='flight')).map(s=>[s.lat,s.lng]);
  let fallbackLine=null;
  if(straight.length>1)fallbackLine=L.polyline(straight,{color:'#C1512D',weight:3,opacity:0.6}).addTo(routeLayer);
  try{
    const rc=await fetchRoute(routeStops);
    if(gen!==_mapGen)return;
    if(rc){
      // Real road route available — replace the straight connector with it.
      if(fallbackLine)routeLayer.removeLayer(fallbackLine);
      L.polyline(rc.map(c=>[c[1],c[0]]),{color:'#C1512D',weight:3.5,opacity:0.75}).addTo(routeLayer);
    }
    st.style.display='none';
  }catch(e){st.style.display='none'}
}

function updateTabsTop(){
  const hdr=document.querySelector('header');
  const bar=document.getElementById('tabs-bar');
  if(hdr&&bar){bar.style.position='sticky';bar.style.top=hdr.offsetHeight+'px';}
}
function tabsScroll(dir){
  const bar=document.getElementById('tabs-inner');
  bar.scrollBy({left:dir*160,behavior:'smooth'});
}
function updateTabScrollBtns(){
  const bar=document.getElementById('tabs-inner');
  const btnL=document.getElementById('tabs-scroll-left');
  const btnR=document.getElementById('tabs-scroll-right');
  if(!bar||!btnL||!btnR)return;
  const overflows=bar.scrollWidth>bar.clientWidth+4;
  btnL.style.display=overflows?'block':'none';
  btnR.style.display=overflows?'block':'none';
}
function renderTabs(){
  const bar=document.getElementById('tabs-inner');bar.innerHTML='';
  const ov=document.createElement('div');
  ov.className='tab-item'+(currentDayIdx===-1?' active active-ruby':'');
  ov.innerHTML='<button class="tab-btn" onclick="switchDay(-1)">&#9776; Overview</button>';
  bar.appendChild(ov);
  state.days.forEach((d,i)=>{
    const accentClass=['ruby','pine','river'][i%3];
    const item=document.createElement('div');
    item.className='tab-item'+(i===currentDayIdx?' active active-'+accentClass:'');
    item.setAttribute('draggable','true');item.dataset.dayIdx=i;
    item.innerHTML='<button class="tab-move" aria-label="Move Day '+(i+1)+' earlier" title="Move day earlier" onclick="moveDay('+i+',-1)" '+(i===0?'disabled':'')+'>&#8592;</button><button class="tab-btn" onclick="switchDay('+i+')">Day '+(i+1)+'</button><button class="tab-move" aria-label="Move Day '+(i+1)+' later" title="Move day later" onclick="moveDay('+i+',1)" '+(i===state.days.length-1?'disabled':'')+'>&#8594;</button><button class="tab-remove" aria-label="Remove Day '+(i+1)+'" onclick="removeDay('+i+')" title="Remove day">&times;</button>';
    bar.appendChild(item);
  });
  const add=document.createElement('button');
  add.className='tab-add';add.title='Add day';add.innerHTML='+';add.onclick=addDay;
  bar.appendChild(add);
  requestAnimationFrame(()=>{
    updateTabScrollBtns();
    const active=bar.querySelector('.tab-item.active');
    if(active)active.scrollIntoView({block:'nearest',inline:'nearest'});
  });
}

// A LOCAL calendar date as YYYY-MM-DD. new Date(iso+'T00:00:00') is LOCAL
// midnight, so .toISOString() shifts it to UTC and lands on the PREVIOUS day for
// every positive UTC offset (UK, Europe, Asia). That silently broke the
// "roll the end date to the next day" logic abroad — exactly where this app is
// going. Never use toISOString() for a calendar date.
function _localISO(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function dayDateStr(dayIdx){
  const day=state.days[dayIdx];if(!day)return'';
  const sub=day.subtitle||'';
  const datePart=sub.split(/\s*[·•]\s*/)[0].trim();
  if(!datePart)return'';
  const d=_parseTripDate(datePart);
  if(!d)return'';
  return _localISO(d);
}
function findDayByDate(dateStr){
  if(!dateStr)return -1;
  for(let i=0;i<state.days.length;i++){if(dayDateStr(i)===dateStr)return i;}
  return -1;
}
function setTripStartDate(isoDate){
  if(!isoDate)return;
  const newStart=new Date(isoDate+' 12:00');
  if(isNaN(newStart.getTime()))return;
  const oldStartIso=dayDateStr(0);
  const oldStart=oldStartIso?new Date(oldStartIso+' 12:00'):null;
  state.days.forEach((day,i)=>{
    // keep each day's offset from the old start; fall back to consecutive days
    let offset=i;
    if(oldStart){
      const ownIso=dayDateStr(i);
      if(ownIso){
        offset=Math.round((new Date(ownIso+' 12:00')-oldStart)/86400000);
      }
    }
    const d=new Date(newStart.getTime()+offset*86400000);
    const dateLabel=d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    const parts=(day.subtitle||'').split(/\s*[·•]\s*/);
    const hadDate=parts[0]&&_parseTripDate(parts[0].trim())!==null;
    if(hadDate)parts[0]=dateLabel;
    else parts.unshift(dateLabel);
    day.subtitle=parts.filter(Boolean).join(' · ');
  });
  saveState('Changed trip start date');
  renderAll();
}
function parsedTransitRoute(s){
  if(s.from||s.to)return{from:s.from||'—',to:s.to||'—'};
  const n=s.name;
  const m=n.match(/—\s*(.+?)\s+to\s+(.+?)(?:\s*\||$)/i);
  if(m)return{from:m[1].trim(),to:m[2].trim()};
  const m2=n.match(/^(.+?)\s+to\s+(.+?)(?:\s*\||$)/i);
  if(m2)return{from:m2[1].trim(),to:m2[2].trim()};
  return null;
}
function badge(type){const l={hike:'Hike',food:'Food',lodge:'Lodging',drive:'Drive',flight:'Flight',train:'Train',bus:'Bus'};return'<span class="badge badge-'+type+'">'+(l[type]||type)+'</span>'}
function flightAwareLink(name,notes,flightNumber){
  /* IATA → ICAO lookup so FlightAware URLs resolve correctly */
  const ICAO={'Z0':'UBT','DY':'NAX','BA':'BAW','AA':'AAL','DL':'DAL','UA':'UAL','VS':'VIR','AF':'AFR','KL':'KLM','LH':'DLH','IB':'IBE','LX':'SWR','OS':'AUA','AY':'FIN','SK':'SAS','TK':'THY','EK':'UAE','QR':'QTR','EY':'ETD','SQ':'SIA','CX':'CPA','AC':'ACA','WS':'WJA','EI':'EIN','FR':'RYR','U2':'EZY','LS':'EXS','W6':'WZZ','VY':'VLG','EW':'EWG','HV':'TRA','DE':'CFG','BY':'TOM','LM':'LOG','T3':'EZE','KM':'AMC','AZ':'AZA','TP':'TAP','SN':'DAT','LO':'LOT','OK':'CSA','A3':'AEE','OA':'OAL','BT':'BTI','JU':'ASL','OU':'CTN','FZ':'FDB','QF':'QFA','NZ':'ANZ','JL':'JAL','NH':'ANA','KE':'KAL','OZ':'AAR','CI':'CAL','BR':'EVA','TG':'THA','6E':'IGO','AI':'AIC','WN':'SWA','B6':'JBU','AS':'ASA','NK':'NKS','F9':'FFT','G4':'AAY','SY':'SCX','TS':'TSC','FI':'ICE','WB':'RWD','4U':'GWI','VX':'VRD','SV':'SVA','MS':'MSR','ET':'ETH','RJ':'RJA','GF':'GFA','WY':'OAS','PK':'PIA'};
  let code,num;
  if(flightNumber){
    /* Use the explicit flight number field — strip spaces and parse */
    const m=(flightNumber.trim()).match(/^([A-Z][A-Z0-9]{1,2})\s*(\d{1,4})$/i);
    if(!m)return'';
    code=m[1].toUpperCase();num=m[2];
  }else{
    /* Fall back to parsing stop name/notes */
    const text=(name||'')+' '+(notes||'');
    const m=text.match(/\b([A-Z][A-Z0-9]{1,2})\s*(\d{1,4})\b/);
    if(!m)return'';
    code=m[1];num=m[2];
  }
  const icao=ICAO[code]||code;
  return'<a class="map-link" href="https://www.flightaware.com/live/flight/'+icao+num+'" target="_blank" rel="noopener">&#9992; FlightAware</a>';
}

const _BOOK_KW=/pre-?book|book in advance|book now|sells out|timed entry|timed slot/i;
function renderDaySummary(day,idx){
  const chips=[];
  const lodgeStop=[...day.stops].reverse().find(s=>s.type==='lodge'&&!/^depart\b/i.test(s.name));
  if(lodgeStop){
    const nm=lodgeStop.name.replace(/^check.?in\s*[—–\-]\s*/i,'').replace(/\s*[—–].*/,'').trim();
    chips.push('<span class="day-sum-item day-sum-sleep">&#127970; '+nm+'</span>');
  }
  const flightStops=day.stops.filter(s=>s.type==='flight');
  const seen=new Set();
  flightStops.forEach(s=>{
    const m=(s.name+' '+(s.notes||'')).match(/\b([A-Z][A-Z0-9]{1,2})\s*(\d{1,4})\b/);
    if(m&&!seen.has(m[1]+m[2])){seen.add(m[1]+m[2]);chips.push('<span class="day-sum-item day-sum-flight">&#9992; '+m[1]+' '+m[2]+'</span>');}
  });
  const trainCount=day.stops.filter(s=>s.type==='train').length;
  if(trainCount>0)chips.push('<span class="day-sum-item day-sum-train">&#128642; '+trainCount+' train'+(trainCount>1?'s':'')+'</span>');
  const busCount=day.stops.filter(s=>s.type==='bus').length;
  if(busCount>0)chips.push('<span class="day-sum-item day-sum-bus">&#128652; '+busCount+' bus'+(busCount>1?'es':'')+'</span>');
  const hasCar=day.stops.some(s=>s.type==='drive'&&/pick.?up|rental/i.test(s.name));
  if(hasCar)chips.push('<span class="day-sum-item day-sum-drive">&#128663; Car day</span>');
  const bookedN=day.stops.filter(s=>s.reservation).length;
  const toBookN=day.stops.filter(s=>!s.reservation&&(['lodge','flight','train','bus'].includes(s.type)||_BOOK_KW.test(s.notes||''))&&!/^depart\b/i.test(s.name)).length;
  if(bookedN>0||toBookN>0){
    const parts=[];
    if(bookedN>0)parts.push('&#10003; '+bookedN+' booked');
    if(toBookN>0)parts.push('&#9900; '+toBookN+' to book');
    chips.push('<span class="day-sum-item '+(toBookN>0?'day-sum-book-warn':'day-sum-book')+'">'+parts.join(' &middot; ')+'</span>');
  }
  if(chips.length===0)return'';
  return'<div class="day-summary">'+chips.join('')+'</div>';
}

// Recognise a stop as lodging even when it was mistyped (e.g. a hotel saved as
// "food"). type==='lodge' is the strong signal; otherwise the name must clearly
// look like accommodation. High precision on purpose: bare "inn"/"lodge"/"manor"
// are NOT used because UK pubs/restaurants use them constantly ("Guy Fawkes Inn",
// "Star Inn"). Only unambiguous hotel words, plus explicit multi-word chains.
const _LODGE_NAME_RE=/\b(hotels?|motels?|hostels?|resorts?|travelodge|premier\s*inn|holiday\s*inn|guest\s*house|guesthouse|b&b|bed\s*(?:&|and)\s*breakfast|ryokan|airbnb)\b/i;
// Meal/food stops are never lodging, even if the venue name contains "Inn" etc.
// Reject on the NAME (a "Dinner — …" / "Lunch — …" stop), NOT merely on type,
// so a real hotel that was mistyped as "food" is still caught by its name.
const _MEAL_PREFIX_RE=/^(dinner|lunch|breakfast|brunch|coffee|drinks|snack|tea|supper)\b/i;
// Names that describe an ACTIVITY, not a place you sleep. Even if such a stop is
// mistyped as "lodge" (e.g. a walk the AI relabelled), it must never be treated
// as the overnight hotel — you do not sleep on the city walls.
const _ACTIVITY_NAME_RE=/\b(walk|tour|hike|trail|museum|minster|cathedral|church|castle|palace|abbey|priory|market|bridge|chapel|gallery|viaduct|fort|garden|gardens|viking|vaults?|tattoo|cruise|seat|square|park|centre|center|visitor)\b/i;
function _isLodgeStop(s){
  if(!s)return false;
  const nm=s.name||'';
  if(/^depart\b/i.test(nm))return false;
  if(_MEAL_PREFIX_RE.test(nm))return false;
  const looksHotel=_LODGE_NAME_RE.test(nm);
  // An activity-named stop is lodging ONLY if it also carries a real hotel word
  // (e.g. "Castle Hotel"). Otherwise it is an outing, never the night's hotel.
  if(_ACTIVITY_NAME_RE.test(nm)&&!looksHotel)return false;
  if(s.type==='lodge')return true;
  return looksHotel;
}
// Most recent lodging on or before dayIdx (a stay you may still be checked into).
function _lastLodgeUpTo(dayIdx){
  for(let i=Math.min(dayIdx,state.days.length-1);i>=0;i--){
    const stops=state.days[i].stops;
    for(let si=stops.length-1;si>=0;si--){
      if(_isLodgeStop(stops[si]))return stops[si];
    }
  }
  return null;
}
// Hotel you START a day from (checked into on this day or an earlier one).
function getHotelForDay(dayIdx){
  return _lastLodgeUpTo(dayIdx);
}
// Hotel you sleep at at the END of a day. Prefer a lodging stop within THIS day
// (the last one, i.e. where the day ends up). If the day has none you're
// continuing a stay from a previous night — so look BACKWARD, never forward to a
// future day's hotel. On the trip's final day with no lodging, you're heading
// home: return null so no phantom "Tonight" hotel is shown.
function getNextHotelForDay(dayIdx){
  const day=state.days[dayIdx];
  if(day){
    for(let si=day.stops.length-1;si>=0;si--){
      if(_isLodgeStop(day.stops[si]))return day.stops[si];
    }
  }
  if(dayIdx>=state.days.length-1)return null;
  return _lastLodgeUpTo(dayIdx-1);
}
// `where` locates the ACTUAL stop this bookend mirrors ({dayIdx,stopIdx}), so the
// hotel can be edited from the bookend instead of only from its own day's card.
// Where does this exact stop object live? Identity match, so the bookend edits the
// real stop rather than a copy.
function _findStopPos(stop){
  try{
    if(!stop||!state||!state.days)return null;
    for(let d=0;d<state.days.length;d++){
      const i=(state.days[d].stops||[]).indexOf(stop);
      if(i>=0)return {dayIdx:d,stopIdx:i};
    }
  }catch(e){}
  return null;
}
function hotelBookendHtml(label,lodge,otherStop,where){
  const nm=lodge.name.replace(/^check.?in\s*[—–\-]\s*/i,'').replace(/\s*[—–].*/,'').trim();
  let travelHtml='';
  if(label.toLowerCase().startsWith('start')&&otherStop&&lodge.lat&&lodge.lng&&otherStop.lat&&otherStop.lng){
    const dist=haversine(lodge.lat,lodge.lng,otherStop.lat,otherStop.lng);
    const tmode=lodge.transitMode||_defaultTransitMode(lodge,otherStop);   // 'subway' is canonicalised to 'train' at load
    const mi=dist<10?dist.toFixed(1):Math.round(dist);
    const tStr=_minsToStr(_travelMins(dist,tmode));
    const mapsUrl='https://www.google.com/maps/dir/?api=1&origin='+lodge.lat+','+lodge.lng+'&destination='+otherStop.lat+','+otherStop.lng+'&travelmode='+(tmode==='walk'?'walking':tmode==='train'?'transit':'driving');
    travelHtml='<div class="hotel-bookend-travel"><span class="hotel-bookend-dist">'+mi+' mi · '+tStr+' '+(TM_LABEL[tmode]||'Drive').toLowerCase()+'</span><a class="map-link" href="'+mapsUrl+'" target="_blank" rel="noopener"><svg width="9" height="11" viewBox="0 0 30 36" fill="currentColor" style="flex-shrink:0"><path d="M15 0C7.268 0 1 6.268 1 14c0 8.836 14 22 14 22S29 22.836 29 14C29 6.268 22.732 0 15 0z"/></svg> Directions</a></div>';
  }
  const editBtn=(where&&where.dayIdx>=0&&where.stopIdx>=0)
    ?'<button class="card-btn edit-btn" onclick="openEditStopModal('+where.dayIdx+','+where.stopIdx+')" title="Edit '+_escHtml(nm)+'" style="flex-shrink:0;align-self:center">&#9998;</button>'
    :'';
  return'<div class="hotel-bookend"><span class="hotel-bookend-icon">&#127970;</span><div style="flex:1"><div class="hotel-bookend-label">'+_escHtml(label)+'</div><div class="hotel-bookend-name">'+_escHtml(nm)+'</div>'+travelHtml+'</div>'+editBtn+'</div>';
}

function transitBookendHtml(transitStop,firstStop){
  const ICONS={flight:'&#9992;',train:'&#128642;',bus:'&#128652;'};
  const LABELS={flight:'In flight',train:'On train',bus:'On bus'};
  const icon=ICONS[transitStop.type]||'&#128652;';
  const label=LABELS[transitStop.type]||'In transit';
  const arrTime=firstStop&&firstStop.time?(' &middot; arriving '+firstStop.time):'';
  const nm=transitStop.name.replace(/^check.?in\s*[—–\-]\s*/i,'').trim();
  return'<div class="hotel-bookend"><span class="hotel-bookend-icon">'+icon+'</span><div style="flex:1"><div class="hotel-bookend-label">'+_escHtml(label)+arrTime+'</div><div class="hotel-bookend-name">'+_escHtml(nm)+'</div></div></div>';
}

function _getTodayDayIdx(){
  const today=new Date();today.setHours(0,0,0,0);
  for(let i=0;i<(state?.days||[]).length;i++){
    const iso=dayDateStr(i);if(!iso)continue;
    const d=new Date(iso+' 12:00');d.setHours(0,0,0,0);
    if(d.getTime()===today.getTime())return i;
  }
  return -1;
}
function _getUpNextStopIdx(dayIdx){
  const now=new Date();
  const nowMins=now.getHours()*60+now.getMinutes();
  const stops=state.days[dayIdx]?.stops||[];
  for(let si=0;si<stops.length;si++){
    const t=_parseTimeMins(stops[si].time);
    if(t!==null&&t>nowMins)return si;
  }
  return -1;
}
function renderPanel(idx){
  const day=state.days[idx];if(!day)return'';
  const prevHotel=getHotelForDay(idx-1);
  const todayHotel=getNextHotelForDay(idx);
  const TRANSIT=['flight','train','bus'];
  const prevDay=idx>0?state.days[idx-1]:null;
  const prevLastStop=prevDay&&prevDay.stops.length?prevDay.stops[prevDay.stops.length-1]:null;
  const prevEndsInTransit=prevLastStop&&TRANSIT.includes(prevLastStop.type);
  const todayLastStop=day.stops.length?day.stops[day.stops.length-1]:null;
  const todayEndsInTransit=todayLastStop&&TRANSIT.includes(todayLastStop.type);
  const showStart=!!prevHotel&&day.stops.length>0&&!prevEndsInTransit;
  const showEnd=!!todayHotel&&day.stops.length>0&&!todayEndsInTransit;
  // If tonight's hotel IS the last stop card, don't repeat it as a bookend.
  const _tonightIsLastStop=showEnd&&todayHotel===todayLastStop;
  const conflicts=detectConflicts(idx);
  const jnlMode=isJournalMode();
  const wxCache=_wxDayCache[idx]||null;
  const WX_OUTDOOR=['hike','drive'];
  const _todayDayIdx=_getTodayDayIdx();
  const _upNextSi=_todayDayIdx===idx?_getUpNextStopIdx(idx):-1;
  let cards=_continuationHtml(idx)+
    (prevEndsInTransit&&day.stops.length>0?transitBookendHtml(prevLastStop,day.stops[0]):
    showStart?hotelBookendHtml('Starting from',prevHotel,day.stops[0],_findStopPos(prevHotel)):'');
  day.stops.forEach((s,si)=>{
    const isFirst=si===0,isLast=si===day.stops.length-1;
    const _tr=['flight','train','bus'].includes(s.type)?parsedTransitRoute(s):null;
    const _isUpNext=si===_upNextSi;
    cards+='<div class="stop-card'+(s.alt?' alt-stop':'')+(_isUpNext?' up-next':'')+'" id="stop-card-'+idx+'-'+si+'" style="animation-delay:'+si*40+'ms">'+
      '<div class="stop-dot dot-'+(s.type||'drive')+'">'+(si+1)+'</div>'+
      '<div class="card-controls" ontouchstart="event.stopPropagation()">'+
      '<button class="card-btn" aria-label="Move stop earlier" onclick="moveStop('+idx+','+si+',-1)" title="Move up" '+(isFirst?'disabled':'')+'>&#9650;</button>'+
      '<button class="card-btn edit-btn" onclick="openEditStopModal('+idx+','+si+')" title="Edit stop">&#9998;</button>'+
      '<button class="card-btn" onclick="deleteStop('+idx+','+si+')" title="Remove" style="font-size:16px">&times;</button>'+
      '<button class="card-btn" aria-label="Move stop later" onclick="moveStop('+idx+','+si+',1)" title="Move down" '+(isLast?'disabled':'')+'>&#9660;</button>'+
      '<button class="card-btn" onclick="openCopyModal('+idx+','+si+')" title="Copy to another day" style="font-size:11px">&#8599;</button>'+
      '</div>'+
      '<div class="card-top">'+(s.time?'<span class="card-time">'+(s.locked?'<span title="Reserved time — locked" style="margin-right:3px">&#128274;</span>':'')+_escHtml(s.time)+(_startTz(s)?'<span class="card-tz">'+_escHtml(_startTz(s))+'</span>':'')+_startEndDateHtml(s,idx)+' </span>':'')+'<div class="card-main">'+
      '<div class="card-name">'+(_isUpNext?'<span class="up-next-badge">Up next</span>':'')+_escHtml(s.name)+(s.alt?' <span style="font-weight:400;font-size:12px">(alternate)</span>':'')+(conflicts[si]?'<span class="conflict-badge" tabindex="0">&#9888;<span class="ctip">'+conflicts[si].map(_escHtml).join('<br>')+'</span></span>':'')+(WX_OUTDOOR.includes(s.type)?_wxWarnHtml(wxCache):'')+(s.recentlyChanged?'<span class="recently-changed-dot" title="Recently changed by AI"></span>':'')+'</div>'+
      (_tr?'<div class="card-notes" style="font-size:12px;font-weight:600;margin-top:3px">'+_escHtml(_tr.from)+' → '+_escHtml(_tr.to)+'</div>':'')+
      _airportArrivalHtml(s)+
      // SAME-DAY previous stop only. Using the previous DAY's last stop compared
      // bare minutes-since-midnight, so yesterday's 9:30 PM dinner made a 10:00 AM
      // flight today look unreachable and showed a red impossible warning.
      _airportWarningHtml(si>0?day.stops[si-1]:null,s)+
      (_displayDuration(s,dayDateStr(idx))?'<span class="card-duration">&#9201; '+_escHtml(_displayDuration(s,dayDateStr(idx)))+'</span>':'')+
      (s.stars?'<div class="card-stars">&#9733; '+_escHtml(s.stars)+'</div>':'')+
      (s.notes?'<div class="card-notes">'+_escHtml(s.notes)+'</div>':'')+
      (s.reservation?'<div class="card-notes" style="margin-top:4px;font-size:11.5px;font-weight:600;color:var(--pine);letter-spacing:0.03em">&#128203; Conf&nbsp;#&nbsp;'+_escHtml(s.reservation)+'</div>':'')+
      '</div></div><div class="badges">'+badge(s.type)+(s.alt?'<span class="badge badge-alt">Alternate</span>':'')+(s.reservation?'<span class="badge badge-booked">&#10003; Booked</span>':(['lodge','flight','train','bus'].includes(s.type)||/pre-?book|book in advance|book now|sells out|timed entry|timed slot/i.test(s.notes||''))&&!/^depart\b/i.test(s.name)?'<span class="badge badge-tobook">&#128197; To Book</span>':'')+'</div>'+
      _audioBadgeHtml(s)+
      (s.ticketImage?'<button class="ticket-view-btn" onclick="showTicketViewer('+idx+','+si+')">&#127903; View Ticket</button>':'')+
      (s.lat&&s.lng?'<a class="map-link" href="https://www.google.com/maps/search/?api=1&query='+s.lat+','+s.lng+'" target="_blank" rel="noopener"><svg width="9" height="11" viewBox="0 0 30 36" fill="currentColor" style="flex-shrink:0"><path d="M15 0C7.268 0 1 6.268 1 14c0 8.836 14 22 14 22S29 22.836 29 14C29 6.268 22.732 0 15 0z"/></svg> Directions</a>':'')+
      (!['drive','flight','train','bus'].includes(s.type)?'<button class="map-link" onclick="fixStopLocation('+idx+','+si+')" style="border:none;background:none;cursor:pointer;font:inherit" title="Wrong pin on the map? Re-locate this stop from its name">&#128205; Fix pin</button>':'')+
      (s.type==='flight'?flightAwareLink(s.name,s.notes,s.flightNumber)+''+_checkinLink(s.flightNumber,s.airline):'')+
      _bookingLinkHtml(s)+
      (_isUpNext&&s.lat&&s.lng?'<a class="live-nav-btn" href="https://www.google.com/maps/dir/?api=1&destination='+s.lat+','+s.lng+'" target="_blank" rel="noopener">&#127907; Navigate Here</a>':'')+
      (s.type==='lodge'&&isLast&&idx<state.days.length-1?'<button class="lodge-next-btn" onclick="openCopyModal('+idx+','+si+')">&#8594; Copy to start of Day '+(idx+2)+'</button>':'')+
      '<div class="stop-img-wrap" id="stopimg-'+idx+'-'+si+'" style="position:relative"></div>'+
      (!['drive','flight','train','bus'].includes(s.type)?'<div class="stopdesc-wrap" id="stopdesc-'+idx+'-'+si+'">'+(s.desc?'<div class="stop-desc"><span class="stop-desc-text">'+_escHtml(s.desc)+'</span><button class="stop-desc-regen" onclick="refreshStopDesc('+idx+','+si+')" title="Regenerate">&#8635;</button></div>':'<button class="stop-desc-btn" onclick="generateStopDesc('+idx+','+si+')">&#10024; Describe</button>')+'</div>':'')+
      _dayHoursHtml(s,idx,si)+
      (s.type==='food'?'<button class="alt-btn" onclick="showAlternates('+idx+','+si+')">&#128260; Alternates</button>':'')+
      _stopPlaceMetaHtml(s)+
      _guidebookHtml(s,idx,si)+
      _attendanceHtml(s)+
      (jnlMode?_jnlStopHtml(idx,si):'')+
      '</div>';
    if(!isLast){
      const next=day.stops[si+1];
      const rawMode=s.transitMode||_defaultTransitMode(s,next);
      const tmode=rawMode;
      // Show the distance on the leg that ARRIVES at a real (coordinate-having)
      // place, bridging back over coordinate-less waypoints (drives/fuel stops)
      // so the drive distance appears once instead of some legs blank, some not.
      // Do NOT draw a travel-distance leg INTO a drive stop: a "Drive — A to B"
      // stop already IS that travel (with its own duration), so a leg to it
      // double-counts and makes an impossible-looking "77 mi in 0 min" connector.
      let leg='';
      if(_validLL(next)&&next.type!=='drive'){
        const from=_validLL(s)?s:_legEndpoint(day.stops,si,-1);
        if(from&&from!==next)leg=legLabel(from,next,tmode);
      }
      const tzc=tzChangeLabel(s,next);
      const modePill='<span class="leg-mode-pill '+(TM_CLS[tmode]||TM_CLS.drive)+'">'+(TM_ICON[tmode]||'🚗')+' '+(TM_LABEL[tmode]||'Drive')+'</span>';
      // Red warning right on the connector when the schedule can't fit this leg.
      let infeasWarn='';
      if(_validLL(next)&&next.type!=='drive'){
        const from2=_validLL(s)?s:_legEndpoint(day.stops,si,-1);
        const tv=(from2&&from2!==next)?_legTravelMins(from2,next):0;
        const ps2=_parseTimeMins(s.time),pe2=_parseTimeMins(s.endTime),tn2=_parseTimeMins(next.time);
        if(ps2!==null&&tn2!==null&&tv>=15&&tv<=600){
          const dep2=(pe2!==null&&pe2>ps2)?pe2:ps2+_stopVisitMins(s);
          if(tn2<dep2+tv-10)infeasWarn='<span style="color:var(--ruby);font-weight:700;margin-left:10px">&#9888;&#65039; Not enough time — earliest arrival '+_formatTimeMins(dep2+tv)+'</span>';
        }
      }
      if(leg||tzc){
        cards+='<div class="leg-connector"><span class="leg-connector-arrow">&#8595;</span>'+(leg||'')+modePill+
          (tzc?'<span class="tz-change" style="margin-left:'+(leg?'10px':'0')+'">&#9201; '+tzc+'</span>':'')+infeasWarn+
          '</div>';
      }else{
        cards+='<div class="leg-connector"><span class="leg-connector-arrow">&#8595;</span>'+modePill+'</div>';
      }
    }
  });
  const panelCls='day-panel'+(idx===currentDayIdx?' active':'');
  return'<div class="'+panelCls+'" id="panel-'+idx+'">'+
    '<div class="day-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">'+
    '<div><h2>'+_escHtml(day.title)+'</h2>'+(day.subtitle?'<p>'+_escHtml(_fmtSubtitle(day.subtitle))+'</p>':'')+'</div>'+
    '<div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap;margin-top:2px">'+
    '<button class="ai-action-btn" onclick="optimizeDay('+idx+')">&#10024; Optimize Day</button>'+
    '<button class="ai-action-btn" id="hours-btn-'+idx+'" onclick="addDayOpeningHours('+idx+')" title="Add each stop\'s opening hours for this day">&#128337; Hours</button>'+
    '<button class="ai-action-btn" id="alerts-btn-'+idx+'" onclick="enableTravelAlerts('+idx+')" title="Schedule departure reminders for each stop">&#128276; Alerts</button>'+
    '</div>'+
    '</div>'+
    (jnlMode?_jnlDayHtml(idx):'')+
    renderDaySummary(day,idx)+
    (day.stops.length>0?'<div class="day-narr" id="day-narr-'+idx+'"><div class="day-narr-label">&#127918; Today\'s Briefing<button class="day-narr-refresh" onclick="refreshDayNarrative('+idx+')">&#8635; Refresh</button></div><div class="day-narr-body narr-loading" id="day-narr-body-'+idx+'">Preparing your day briefing…</div></div>':'')+
    (_todayDayIdx===idx?'<div class="live-wx-strip" id="live-wx-'+idx+'"></div>':'')+
    (day.nearby?'<div class="day-nearby"><div class="day-nearby-lbl">&#128205; Nearby Worth Knowing</div><div class="day-nearby-text">'+_escHtml(day.nearby)+'</div></div>':'')+
    '<div class="timeline">'+cards+(showEnd&&!_tonightIsLastStop&&todayLastStop?(()=>{const rawMode=todayLastStop.transitMode||_defaultTransitMode(todayLastStop,todayHotel);const tmode=rawMode;const leg=legLabel(todayLastStop,todayHotel,tmode);const modePill='<span class="leg-mode-pill '+(TM_CLS[tmode]||TM_CLS.drive)+'">'+(TM_ICON[tmode]||'🚗')+' '+(TM_LABEL[tmode]||'Drive')+'</span>';return'<div class="leg-connector"><span class="leg-connector-arrow">&#8595;</span>'+(leg||'')+modePill+'</div>';})():'')+
    (showEnd?hotelBookendHtml('Tonight',todayHotel,todayLastStop,_findStopPos(todayHotel)):'')+
    '<button class="add-stop-btn" onclick="openAddStopModal('+idx+')">'+
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="4.5" x2="8" y2="11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="4.5" y1="8" x2="11.5" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Add Stop</button></div>'+
    (day.tip?'<div class="pro-tip"><div class="pro-tip-label">Pro Tip — Day '+(idx+1)+'</div><p>'+_escHtml(day.tip)+'</p></div>':'')+
    '</div>';
}

/* ---- Wikipedia stop images ---- */
const IMG_LS='stop_img_v4';
let imgData={};
try{imgData=JSON.parse(localStorage.getItem(IMG_LS)||'{}')}catch(e){}

function extractImageKeyword(name){
  const GENERIC=/^(land(?:ing)?|drive|driving|train|flight|bus|depart(?:ure)?|arriv(?:e|al)|transfer|return|pick.?up|drop.?off|check.?in|check.?out|flying|fly)\b/i;
  const FILLER=/\s+(dinner|lunch|breakfast|brunch|drinks|coffee|evening|morning|afternoon|tour|session|hike|trail|restaurant|cafe|hotel|motel|inn|buffet|bar|grill|patio)\s*$/i;
  let s=name.replace(/\bNP\b/,'National Park').replace(/\bSP\b/,'State Park').replace(/\bNF\b/,'National Forest');
  const segs=s.split(/\s*[—–]\s*|\s+-\s+/).map(p=>p.replace(/\s*\([^)]*\)/g,'').replace(FILLER,'').trim()).filter(p=>p.length>2);
  for(const seg of segs){
    if(seg.split(/\s+/).length<=2&&GENERIC.test(seg))continue;
    const toM=seg.match(/^.+?\s+to\s+(.+)$/i);
    if(toM)return toM[1].replace(/\s*\([^)]*\)/g,'').trim();
    return seg.replace(/^(?:the|a|an)\s+/i,'');
  }
  const fb=name.match(/\bto\s+([A-Z][^,\n]+)/);
  if(fb)return fb[1].replace(/\s*\([^)]*\)/g,'').trim();
  return name.replace(/\s*[—–]\s*.*/,'').replace(/\s*\([^)]*\)/g,'').trim();
}

async function fetchStopImage(name){
  if(name in imgData)return imgData[name];
  const q=extractImageKeyword(name);
  if(!q||q.length<4){imgData[name]=null;return null}
  try{
    const url='https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&generator=search&gsrsearch='+
      encodeURIComponent(q)+'&gsrlimit=1&pithumbsize=500&format=json&origin=*';
    const r=await fetch(url);
    if(!r.ok){imgData[name]=null;return null}
    const d=await r.json();
    const pages=Object.values(d.query?.pages||{});
    const img=pages[0]?.thumbnail?.source||null;
    imgData[name]=img;
    try{localStorage.setItem(IMG_LS,JSON.stringify(imgData))}catch(e){}
    return img;
  }catch(e){imgData[name]=null;return null}
}

let _renderGen=0; // bumped on every renderAll — invalidates in-flight image loads
async function loadStopImages(){
  const gen=_renderGen;
  const allStops=state.days.flatMap((d,di)=>d.stops.map((s,si)=>({stop:s,di,si})));
  // Local (already-decoded) images paint immediately; only network lookups queue.
  const queue=[];
  for(const {stop,di,si} of allStops){
    if(gen!==_renderGen)return;
    const el=document.getElementById('stopimg-'+di+'-'+si);
    if(!el||el.classList.contains('loaded'))continue;
    if(stop.customImage){
      el.innerHTML='<img class="stop-img" src="'+_escHtml(_safeImgSrc(stop.customImage))+'" alt="'+_escHtml(stop.name)+'" loading="lazy"/>';
      el.classList.add('loaded');continue;
    }
    queue.push({stop,di,si});
  }
  // CONCURRENCY POOL. One awaited Wikipedia fetch per stop, in order, made a
  // 60-stop trip painfully slow. Five workers share the queue; the _renderGen
  // staleness checks around every DOM write are preserved exactly.
  let next=0;
  async function worker(){
    while(next<queue.length){
      if(gen!==_renderGen)return;
      const {stop,di,si}=queue[next++];
      const url=await fetchStopImage(stop.name);
      // Re-check generation AND re-fetch the element after the await so a stale
      // fetch can never paint a photo onto a stop that has since moved/changed.
      if(gen!==_renderGen)return;
      const el2=document.getElementById('stopimg-'+di+'-'+si);
      if(url&&el2&&!el2.classList.contains('loaded')){
        el2.innerHTML='<img class="stop-img" src="'+_escHtml(url)+'" alt="'+_escHtml(stop.name)+'" loading="lazy"/><span class="stop-img-credit">&#169; Wikipedia / CC</span>';
        el2.classList.add('loaded');
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(5,queue.length)},worker));
}

/* ---- Offline download ---- */
const _OFFLINE_CACHE='seasons-offline';
function _lon2tileX(lon,z){return Math.floor((lon+180)/360*Math.pow(2,z));}
function _lat2tileY(lat,z){const r=lat*Math.PI/180;return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*Math.pow(2,z));}
// Map tiles covering every stop, a few zoom levels each, deduped and capped.
function _tripTileUrls(cap){
  const set=new Set();
  const stops=state.days.flatMap(d=>d.stops).filter(s=>s.lat&&s.lng);
  for(const z of [5,9,12,14]){
    for(const s of stops){
      const x=_lon2tileX(s.lng,z),y=_lat2tileY(s.lat,z);
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
        set.add('https://tile.openstreetmap.org/'+z+'/'+(x+dx)+'/'+(y+dy)+'.png');
      }
    }
  }
  return [...set].slice(0,cap||500);
}
async function _cachePut(cache,url,opts){
  try{const r=await fetch(url,opts||{});if(r&&(r.ok||r.type==='opaque'))await cache.put(url,r);}catch(e){}
}
// Download everything needed to view this trip with no internet: the app pages,
// the itinerary state, every stop image, and the map tiles for each stop. Stored
// in a cache that survives app updates and served back by the service worker.
async function downloadTripOffline(){
  const btn=document.getElementById('offline-btn');
  if(btn){btn.disabled=true;btn.innerHTML='&#8987; Saving 0%';}
  try{
    // 1. Persist the itinerary state so it renders offline. localStorage is small
    //    (~5MB); also store in the Cache API (large quota) as a robust fallback.
    const stateJson=JSON.stringify(state);
    const cache=await caches.open(_OFFLINE_CACHE);
    try{localStorage.setItem(LS_KEY,stateJson);}catch(e){}
    try{await cache.put('/Travel/offline-state/'+encodeURIComponent(tripId)+'.json',
      new Response(stateJson,{headers:{'Content-Type':'application/json'}}));}catch(e){}
    // 2. App shell + this trip's page (so navigation works offline).
    // Include the VERSIONED urls too — the pages request trip.js?v=NNN, which
    // would miss an offline cache holding only the bare filename. Derived from
    // APP_CODE_VERSION so release.sh stamping never drifts from a hardcoded number.
    const _v=String(window.APP_CODE_VERSION||'').replace(/^v/,'');
    const shell=['index.html','trip.html','trip.js','trip-extras.js','app.webmanifest',
      'leaf-logo.png','icon-192.png','icon-512.png',location.pathname+location.search]
      .concat(_v?['trip.js?v='+_v,'trip-extras.js?v='+_v]:[]);
    await Promise.all(shell.map(u=>_cachePut(cache,u,{cache:'reload'})));
    if(!location.pathname.includes(tripId))await _cachePut(cache,'trips/'+tripId+'.json',{cache:'reload'});
    // 3. Stop images + 4. map tiles, with a progress counter.
    const stops=state.days.flatMap(d=>d.stops);
    const imgUrls=[];
    for(const s of stops){
      const u=s.customImage||await fetchStopImage(s.name);
      if(u&&/^https?:/.test(u))imgUrls.push(u);
    }
    const tiles=_tripTileUrls(500);
    const jobs=[...imgUrls,...tiles];
    let done=0;
    const step=()=>{done++;if(btn)btn.innerHTML='&#8987; Saving '+Math.round(done/Math.max(1,jobs.length)*100)+'%';};
    // Small concurrency pool so we don't fire hundreds of requests at once.
    const POOL=6;let i=0;
    async function worker(){while(i<jobs.length){const url=jobs[i++];await _cachePut(cache,url,{mode:'no-cors'});step();}}
    await Promise.all(Array.from({length:POOL},worker));
    localStorage.setItem('offline_'+tripId,'1');
    if(btn){btn.disabled=false;btn.innerHTML='&#10003; Saved Offline';}
    showToast('&#10003; Saved for offline viewing');
  }catch(e){
    if(btn){btn.disabled=false;btn.innerHTML='&#11015; Save Offline';}
    alert('Could not finish the offline download. Please try again on a stronger connection.');
  }
}

/* ---- Day narrative (AI) ---- */
const NARR_LS='day_narr_v1';
let narrData={};
try{narrData=JSON.parse(localStorage.getItem(NARR_LS)||'{}')}catch(e){}
// Purge any briefing cached with the old "0°F" weather artifact (the forecast-null
// bug baked "High 0°F / Low 0°F" into the cached text). Deleting it forces a fresh
// briefing with the corrected weather on next view. Runs once at load.
function _purgeStaleWeatherNarratives(){
  try{
    let changed=false;
    for(const k in narrData){ if(/0°F/.test(narrData[k]||'')){ delete narrData[k]; changed=true; } }
    if(changed)localStorage.setItem(NARR_LS,JSON.stringify(narrData));
    return changed;
  }catch(e){ return false; }
}
_purgeStaleWeatherNarratives();

const WX_ICONS={0:'☀️',1:'🌤️',2:'🌤️',3:'☁️',45:'🌫️',48:'🌫️',51:'🌦️',53:'🌦️',55:'🌧️',61:'🌦️',63:'🌧️',65:'🌧️',71:'🌨️',73:'❄️',75:'❄️',80:'🌦️',81:'🌧️',82:'⛈️',85:'🌨️',86:'❄️',95:'⛈️',96:'⛈️',99:'⛈️'};
const WX_LABELS={0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Foggy',48:'Freezing fog',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',80:'Rain showers',81:'Showers',82:'Heavy showers',85:'Snow showers',86:'Snow showers',95:'Thunderstorm',96:'Thunderstorm',99:'Thunderstorm'};
/* Parse "Sun Jun 7", "Jun 7", "June 7, 2026", etc. — infers year from closest to today */
/* Month-name to 0-based index — used by _parseTripDate to avoid new Date(string) quirks */
const _MON={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
  january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,
  september:8,october:9,november:10,december:11};
function _mkDate(monthName,day,year){
  const mi=_MON[monthName.toLowerCase().slice(0,3)];
  if(mi===undefined)return null;
  const d=new Date(year,mi,parseInt(day),12,0,0);
  return(d.getMonth()===mi&&d.getDate()===parseInt(day))?d:null;
}
function _parseTripDate(str){
  if(!str)return null;
  // ISO format: 2026-06-09
  const iso=str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(iso){
    const d=new Date(parseInt(iso[1]),parseInt(iso[2])-1,parseInt(iso[3]),12,0,0);
    if(!isNaN(d.getTime()))return d;
  }
  // Month-name with explicit year: "Jun 6, 2026" / "June 6 2026" / "6 Jun 2026"
  const withYr=str.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/)||
               str.match(/(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})/);
  if(withYr){
    const d=withYr[0].match(/^\d/)?_mkDate(withYr[2],withYr[1],parseInt(withYr[3]))
                                  :_mkDate(withYr[1],withYr[2],parseInt(withYr[3]));
    if(d&&d.getFullYear()>=2020&&d.getFullYear()<=2040)return d;
  }
  // Month-name without year: "Fri Oct 9" / "Oct 9" — infer year closest to today
  const noYr=str.match(/([A-Za-z]{3,9})\s+(\d{1,2})/);
  if(!noYr)return null;
  const now=new Date();now.setHours(12,0,0,0);
  let best=null,bestGap=Infinity;
  for(const yr of[now.getFullYear()-1,now.getFullYear(),now.getFullYear()+1]){
    const c=_mkDate(noYr[1],noYr[2],yr);
    if(!c||c.getFullYear()<2020)continue;
    const gap=Math.abs(c-now);
    if(gap<bestGap){bestGap=gap;best=c;}
  }
  return best;
}
async function fetchDayWeather(day){
  const sub=day.subtitle||'';
  const datePart=sub.split(/\s*[·•]\s*/)[0].trim();
  if(!datePart)return null;
  const date=_parseTripDate(datePart);
  if(!date)return null;
  const coords=day.stops.find(s=>s.lat&&s.lng);
  if(!coords)return null;
  const today=new Date();today.setHours(0,0,0,0);
  const diffDays=Math.round((date-today)/86400000);
  // Climate-average estimate fallback — used when a date is beyond the forecast
  // horizon OR the API returns a row with no real temperature (which used to be
  // rounded to a nonsensical 0°F).
  const climateAvg=()=>({tooFarOut:true,wxType:'climateAvg',month:date.toLocaleString('en-US',{month:'long'}),lat:coords.lat,lng:coords.lng});
  if(diffDays>16)return climateAvg();
  const ds=_localISO(date);
  if(diffDays<0){
    try{
      const r=await fetch('https://archive-api.open-meteo.com/v1/archive?latitude='+coords.lat+'&longitude='+coords.lng+'&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto&temperature_unit=fahrenheit&start_date='+ds+'&end_date='+ds);
      if(!r.ok)return climateAvg();
      const d=await r.json();
      const hi=d.daily?.temperature_2m_max?.[0], lo=d.daily?.temperature_2m_min?.[0];
      if(hi==null||lo==null)return climateAvg();   // no real reading → estimate, NEVER 0°F
      const precip=d.daily.precipitation_sum?.[0];
      return{hi:Math.round(hi),lo:Math.round(lo),precip:precip!=null?Math.round(precip*10)/10:null,precipUnit:'mm',code:d.daily.weathercode?.[0],wxType:'historical',tooFarOut:false};
    }catch(e){return climateAvg();}
  }
  try{
    // forecast_days=16 so dates up to ~2 weeks out actually return data.
    const r=await fetch('https://api.open-meteo.com/v1/forecast?latitude='+coords.lat+'&longitude='+coords.lng+'&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=auto&temperature_unit=fahrenheit&forecast_days=16&start_date='+ds+'&end_date='+ds);
    if(!r.ok)return climateAvg();
    const d=await r.json();
    const hi=d.daily?.temperature_2m_max?.[0], lo=d.daily?.temperature_2m_min?.[0];
    if(hi==null||lo==null)return climateAvg();   // forecast has no reading for this date → estimate, NEVER 0°F
    return{hi:Math.round(hi),lo:Math.round(lo),precip:d.daily.precipitation_probability_max?.[0],code:d.daily.weathercode?.[0],wxType:'forecast',tooFarOut:false};
  }catch(e){return climateAvg();}
}

const NARR_SYSTEM='You are a charismatic tour guide delivering the morning briefing to your group over breakfast. Format your response in exactly two parts separated by a single newline: (1) A weather line starting with a weather emoji, e.g. "☀️ Clear sky · High 82°F / Low 58°F · Climate Avg". End the weather line with the label "Climate Avg". Estimate typical weather for this location and time of year. (2) Two to three flowing, engaging sentences about what the group will experience today, written in second person. Specific, evocative, exciting. Pure prose — no bullets, no headers.';
const NARR_PROSE_SYSTEM='You are a charismatic tour guide delivering the morning briefing over breakfast. Write exactly 2-3 flowing, engaging sentences about what the group will experience today. Second person, specific, evocative, exciting. Pure prose only — no weather line (weather is shown separately), no bullets, no headers.';

function _escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
// Only allow safe link schemes (http/https/mailto/tel) — blocks javascript: URLs.
function _safeUrl(u){u=String(u==null?'':u).trim();return /^(https?:|mailto:|tel:)/i.test(u)?u:'';}
function renderNarrHtml(text){
  const nl=text.indexOf('\n');
  if(nl===-1)return'<div class="day-narr-text">'+_escHtml(text)+'</div>';
  const firstLine=text.slice(0,nl).trim();
  if(!firstLine.includes('°'))return'<div class="day-narr-text">'+_escHtml(text)+'</div>';
  const narr=text.slice(nl+1).trim();
  return'<div class="day-narr-wx">'+_escHtml(firstLine)+'</div>'+(narr?'<div class="day-narr-text">'+_escHtml(narr)+'</div>':'');
}

function dayNarrKey(dayIdx){
  const day=state.days[dayIdx];if(!day)return null;
  const sub=day.subtitle||'';
  const datePart=sub.split(/\s*[·•]\s*/)[0].trim();
  let dateTag='';
  if(datePart){
    const d=_parseTripDate(datePart);
    if(d){
      const today=new Date();today.setHours(0,0,0,0);
      const diff=Math.round((d-today)/86400000);
      if(diff>=-5&&diff<=16)dateTag='|'+_localISO(new Date());
    }
  }
  const sig=day.title+dateTag+'|'+day.stops.map(s=>s.name+(s.notes||'')).join('|');
  let h=0;for(let i=0;i<sig.length;i++)h=(h*31+sig.charCodeAt(i))&0xFFFFFFFF;
  return tripId+'_'+dayIdx+'_'+h.toString(36);
}

async function loadDayNarrative(dayIdx){
  const el=document.getElementById('day-narr-body-'+dayIdx);
  if(!el)return;
  const day=state.days[dayIdx];if(!day||!day.stops.length)return;
  const key=dayNarrKey(dayIdx);if(!key)return;
  if(narrData[key]){el.innerHTML=renderNarrHtml(narrData[key]);el.classList.remove('narr-loading');return;}
  el.classList.add('narr-loading');el.textContent='Preparing your day briefing…';
  try{
    const wx=await fetchDayWeather(day);
    if(wx&&!(dayIdx in _wxDayCache)){_wxDayCache[dayIdx]=wx;}
    const stopList=day.stops.map(s=>s.name+(s.notes?' ('+s.notes+')':'')).join(', ');
    let userPrompt='Day: '+day.title+'\nStops: '+stopList;
    let wxLine=null;
    if(wx&&!wx.tooFarOut){
      const icon=WX_ICONS[wx.code]||'🌡️';
      const cond=WX_LABELS[wx.code]||'';
      const typeLabel=wx.wxType==='historical'?'Historical':'Forecast';
      let precipNote='';
      if(wx.wxType==='historical'){if(wx.precip!=null&&wx.precip>0)precipNote=' · '+wx.precip+'mm rain';}
      else{if(wx.precip>=15)precipNote=' · '+wx.precip+'% rain chance';}
      wxLine=icon+(cond?' '+cond:'')+' · High '+wx.hi+'°F / Low '+wx.lo+'°F'+precipNote+' · '+typeLabel;
      userPrompt+='\nWeather: '+cond+', High '+wx.hi+'°F, Low '+wx.lo+'°F. Reference if relevant to outdoor stops.';
    }else if(wx?.tooFarOut){
      userPrompt+='\nLocation: lat '+Number(wx.lat).toFixed(2)+', lon '+Number(wx.lng).toFixed(2)+'\nMonth: '+wx.month+'\nWeather label: Climate Avg\n(No forecast available — please estimate typical weather for this location in '+wx.month+')';
    }
    const text=await callClaude(wxLine?NARR_PROSE_SYSTEM:NARR_SYSTEM,userPrompt);
    narrData[key]=(wxLine?wxLine+'\n':'')+text.trim();
    try{localStorage.setItem(NARR_LS,JSON.stringify(narrData))}catch(e){}
    const fresh=document.getElementById('day-narr-body-'+dayIdx);
    if(fresh){fresh.innerHTML=renderNarrHtml(narrData[key]);fresh.classList.remove('narr-loading');}
  }catch(e){
    // Show an inline retry instead of hiding the whole briefing (and its Refresh button).
    const fresh=document.getElementById('day-narr-body-'+dayIdx);
    if(fresh){fresh.classList.remove('narr-loading');fresh.innerHTML='<span style="color:var(--muted)">Couldn\'t load the briefing.</span> <button class="day-narr-refresh" onclick="refreshDayNarrative('+dayIdx+')">&#8635; Retry</button>';}
  }
}

function refreshDayNarrative(dayIdx){
  const key=dayNarrKey(dayIdx);
  if(key)delete narrData[key];
  try{localStorage.setItem(NARR_LS,JSON.stringify(narrData))}catch(e){}
  loadDayNarrative(dayIdx);
}

// The Places key lives on the DEVICE, never in synced `state`.
function _gpKey(){ try{ return localStorage.getItem('gp_key_'+tripId)||''; }catch(e){ return ''; } }
// One-time: move a key that was previously written into shared state.
function _migrateGooglePlacesKey(){
  try{
    const k=state&&state.settings&&state.settings.googlePlacesKey;
    if(!k)return false;
    if(!localStorage.getItem('gp_key_'+tripId))localStorage.setItem('gp_key_'+tripId,k);
    delete state.settings.googlePlacesKey;
    return true;
  }catch(e){ return false; }
}
function promptGoogleKey(){
  const key=prompt('Enter your Google Places API key (stored in trip settings):');
  if(key&&key.trim()){
    if(!state.settings)state.settings={};
    // SECURITY: never in `state` — family trips sync `state` to a world-readable
    // Firebase DB, so a key stored there is published. Device-local only.
    try{localStorage.setItem('gp_key_'+tripId,key.trim());}catch(e){}
    saveState('Set Google Places key');
    showToast('Google Places key saved');
    renderAll(); // refresh so the "add a key" hint disappears
  }
}

/* ---- Stop descriptions (AI) ---- */
const DESC_SYSTEM='You are a travel guidebook author writing in the style of Fodor\'s or Rick Steves. Write exactly 2-3 sentences about this location: what it is, why it matters, and what a visitor should look for. Be specific and evocative, not generic. Do not begin with the place name. Do not use markdown or bullet points.';

function _renderDesc(wrap,text,dayIdx,stopIdx){
  wrap.innerHTML='<div class="stop-desc"><span class="stop-desc-text">'+_escHtml(text)+'</span><button class="stop-desc-regen" onclick="refreshStopDesc('+dayIdx+','+stopIdx+')" title="Regenerate">&#8635;</button></div>';
}

async function generateStopDesc(dayIdx,stopIdx){
  const wrap=document.getElementById('stopdesc-'+dayIdx+'-'+stopIdx);if(!wrap)return;
  const stop=state.days[dayIdx]?.stops[stopIdx];if(!stop)return;
  if(stop.desc){_renderDesc(wrap,stop.desc,dayIdx,stopIdx);return;}
  wrap.innerHTML='<span style="font-family:var(--font-ui);font-size:12px;color:var(--muted);animation:narr-pulse 1.5s ease-in-out infinite">Loading…</span>';
  try{
    const parts=[stop.name,'Type: '+stop.type];
    if(stop.notes)parts.push('Notes: '+stop.notes);
    if(stop.lat&&stop.lng)parts.push('Coordinates: '+Number(stop.lat).toFixed(3)+', '+Number(stop.lng).toFixed(3));
    const text=await callClaude(DESC_SYSTEM,parts.join('\n'));
    stop.desc=text.trim();
    saveState();
    const fresh=document.getElementById('stopdesc-'+dayIdx+'-'+stopIdx);
    if(fresh)_renderDesc(fresh,stop.desc,dayIdx,stopIdx);
  }catch(e){
    const fresh=document.getElementById('stopdesc-'+dayIdx+'-'+stopIdx);
    if(fresh)fresh.innerHTML='<button class="stop-desc-btn" onclick="generateStopDesc('+dayIdx+','+stopIdx+')">&#10024; Describe</button>';
  }
}

function refreshStopDesc(dayIdx,stopIdx){
  const stop=state.days[dayIdx]?.stops[stopIdx];if(!stop)return;
  delete stop.desc;
  saveState();
  generateStopDesc(dayIdx,stopIdx);
}

function renderAll(){
  _renderGen++; // invalidate any image loads still in flight from the last render
  // RENDERING MUST NEVER MUTATE THE ITINERARY. _healEarlyDays / _healBadEndTimes /
  // _sortAllDaysByTime all REWRITE times and REORDER stops; running them on every
  // render meant simply looking at the app silently re-timed and re-sorted the day
  // (and the display then disagreed with what was stored). They now run once at
  // load — see _healLoadedItinerary() in init — not on every paint.
  try{ _syncDayHeadings(); }catch(e){}   // headings always reflect the live stops
  // Persist ids created here. renderAll also runs after the 3s poll adopts a cloud
  // state; without saving, fresh _sids were generated every render and journal
  // notes/ratings re-orphaned on each reload. localOnly keeps it off the cloud.
  try{ if(_ensureJnlIds())saveState('',true); }catch(e){}
  try{renderTabs();}catch(e){console.error('[renderTabs]',e);}
  try{
    // Safety net: if the sort somehow left a day out of order, say so loudly
    // instead of silently showing it.
    const _cv=_firstChronoViolation();
    const _errBanner=_cv?'<div style="margin:10px 0;padding:12px 14px;background:rgba(194,59,59,0.12);border:1.5px solid var(--ruby);border-radius:10px;font-family:var(--font-ui);font-size:13px;color:var(--ruby);font-weight:600">&#9888;&#65039; Day '+_cv+' is out of chronological order. This should be impossible &mdash; please tell me the trip and day so I can fix it.</div>':'';
    if(currentDayIdx===-1){
      document.getElementById('content-area').innerHTML=_errBanner+renderOverview();
    }else{
      document.getElementById('content-area').innerHTML=_errBanner+state.days.map((_,i)=>renderPanel(i)).join('');
      loadStopImages();
      if(currentDayIdx>=0){
        loadDayNarrative(currentDayIdx);
        autoLoadDayHours(currentDayIdx);
        const _todayIdx=_getTodayDayIdx();
        if(currentDayIdx===_todayIdx)loadLiveWeather(currentDayIdx);
      }
    }
  }catch(e){
    console.error('[renderAll]',e);
    const ca=document.getElementById('content-area');
    if(ca)ca.innerHTML='<div style="padding:32px;font-family:var(--font-ui);color:var(--ruby)">⚠️ Render error: '+_escHtml(e.message)+'<br><small style="color:var(--muted)">Check browser console for details.</small></div>';
  }
  // ALWAYS refresh the map to match the data (markers/route), without re-zooming.
  // This is why the map stays in sync no matter which action changed the data —
  // no action has to remember to update the map separately anymore.
  try{ if(currentDayIdx===-1)renderOverviewMap(false); else renderDayMap(currentDayIdx,false); }catch(e){console.error('[renderAll map]',e);}
}

function switchDay(idx){
  // The ONLY place that keeps an explicit map call after renderAll: switching days
  // intends a re-zoom (fit=true), whereas renderAll refreshes with fit=false.
  // The generation guard makes the overlap safe.
  currentDayIdx=idx;renderAll();
  if(idx===-1)renderOverviewMap();
  else renderDayMap(idx);
  window.scrollTo({top:0,behavior:'smooth'});
}

function addDay(){
  const n=state.days.length+1;
  state.days.push({title:'Day '+n+' — New Day',subtitle:'Add stops below to build your itinerary',tip:'',stops:[]});
  saveState();switchDay(state.days.length-1);
}

function removeDay(idx){
  if(state.days.length<=1){alert('You must have at least one day.');return}
  if(!confirm('Remove Day '+(idx+1)+'? This cannot be undone.'))return;
  state.days.splice(idx,1);
  _wxDayCache={}; // day indices shifted — weather cache would point at the wrong day
  if(currentDayIdx>=state.days.length)currentDayIdx=state.days.length-1;
  saveState();renderAll();
}

function moveDay(idx,dir){
  const ni=idx+dir;
  if(ni<0||ni>=state.days.length)return;
  [state.days[idx],state.days[ni]]=[state.days[ni],state.days[idx]];
  _wxDayCache={}; // day indices changed — invalidate the index-keyed weather cache
  if(currentDayIdx===idx)currentDayIdx=ni;
  else if(currentDayIdx===ni)currentDayIdx=idx;
  saveState();renderAll();
}

let copyingFrom={dayIdx:0,stopIdx:0};
function openCopyModal(dayIdx,stopIdx){
  copyingFrom={dayIdx,stopIdx};
  const stop=state.days[dayIdx].stops[stopIdx];
  const isLastLodge=stop.type==='lodge'&&stopIdx===state.days[dayIdx].stops.length-1;
  const btns=document.getElementById('copy-day-btns');
  btns.innerHTML=state.days.map((d,i)=>{
    if(i===dayIdx)return'';
    const title=d.title.replace(/^Day \d+ — /,'');
    const startBtn=isLastLodge&&i===dayIdx+1
      ?'<button class="btn-primary" style="font-size:12px;padding:9px 14px;background:var(--pine);margin-bottom:6px;width:100%" onclick="doCopy('+i+',true)">&#8594; Start of Day '+(i+1)+' — as lodging origin</button>'
      :'';
    return'<div style="padding:12px 0;border-bottom:1px solid var(--border)">'+
      '<div style="font-family:var(--font-ui);font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">Day '+(i+1)+' — '+title+'</div>'+
      startBtn+
      '<button class="btn-cancel" style="font-size:12px;padding:8px 14px;width:100%;text-align:left" onclick="doCopy('+i+',false)">Copy to end of Day '+(i+1)+'</button>'+
      '</div>';
  }).join('');
  document.getElementById('copy-modal').classList.add('open');
}
function closeCopyModal(){document.getElementById('copy-modal').classList.remove('open')}
function doCopy(toDayIdx,atStart){
  const stop=JSON.parse(JSON.stringify(state.days[copyingFrom.dayIdx].stops[copyingFrom.stopIdx]));
  delete stop._sid; // give the copy its own journal id so notes/ratings don't bleed between copies
  if(atStart)state.days[toDayIdx].stops.unshift(stop);
  else state.days[toDayIdx].stops.push(stop);
  saveState();closeCopyModal();renderAll();
}

// _parseTimeMins lives ONCE, further down: the anchored, bounds-checked version.
// A second, laxer copy used to sit here and won or lost purely on declaration
// order — a silent drift hazard. Do not add another.
// THE single canonical time format: "8:30 PM". There used to be two formatters
// producing different shapes ("8:30pm" here, "8:30 PM" in _minsToClock), so the
// same instant was written two ways and compared inconsistently. This now
// delegates, so there is exactly one definition of what a time looks like.
function _formatTimeMins(mins){ return _minsToClock(mins); }
function _suggestStopTime(stops,newIdx){
  const prev=newIdx>0?stops[newIdx-1]:null;
  if(!prev||!prev.time)return null;
  const prevMins=_parseTimeMins(prev.time);
  if(prevMins===null)return null;
  const curr=stops[newIdx];
  const VISIT_MINS={hike:180,museum:90,food:75,lodge:30,flight:0,train:0,bus:0,drive:20,beach:120,shop:60,tour:90,show:150};
  const visitDur=VISIT_MINS[prev.type]??60;
  let travelMins=20;
  if(prev.lat&&prev.lng&&curr.lat&&curr.lng){
    const mode=(curr.transitMode||_defaultTransitMode(prev,curr));
    const dist=haversine(prev.lat,prev.lng,curr.lat,curr.lng);
    travelMins=Math.max(5,_travelMins(dist,mode));
  }
  return _formatTimeMins(prevMins+visitDur+travelMins);
}
// How long a stop occupies: prefer an explicit end time, then its duration
// string, then a sensible default for its type.
const _VISIT_MINS={hike:120,museum:90,food:75,lodge:30,flight:0,train:0,bus:0,drive:20,beach:120,shop:60,tour:90,show:150};
function _durationToMins(str){
  if(str==null)return null;
  const s=String(str).toLowerCase().trim();
  if(!s)return null;
  let mins=0,found=false;
  const h=s.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hr|hrs|hour|hours)/);
  if(h){mins+=parseFloat(h[1])*60;found=true;}
  const m=s.match(/(\d+)\s*(?:m\b|min|mins|minute|minutes)/);
  if(m){mins+=parseInt(m[1]);found=true;}
  if(!found){const n=s.match(/^(\d+)$/);if(n){mins=parseInt(n[1]);found=true;}}
  return found?Math.round(mins):null;
}
// Format a minute count as a duration chip string, e.g. 45→"45min", 60→"1hr",
// 90→"1h 30min", 120→"2hrs".
function _fmtDur(mins){
  mins=Math.max(0,Math.round(mins));
  const h=Math.floor(mins/60),m=mins%60;
  if(h===0)return m+'min';
  if(m===0)return h+(h===1?'hr':'hrs');
  return h+'h '+m+'min';
}
// How long a stop occupies. The start→end SPAN is the source of truth; the
// duration string is a calculated mirror of it. Fall back to a stored duration
// only when there is no usable end time yet, then to a per-type default.
// The duration to DISPLAY. Always derived from the stop's own start→end times, so
// a card can never show a duration that contradicts the times printed beside it.
// (The stored s.duration string is a second source of truth and goes stale — e.g.
// a 12:03pm–4:12pm stop showing "2hrs". It is used only when there is no end time.)
// ---- Start/End DATES and TIME ZONES -----------------------------------------
// A stop's start and end each carry their own date and zone, so an overnight
// flight reads "Aug 4, 8:30 PM EDT -> Aug 5, 9:35 AM BST".
// The zone is whatever the user typed; otherwise it is derived from the stop's
// coordinates (the arrival end uses the destination coords when we have them).
// The small date line under a stop's time. Shows the start date, and the end
// date whenever the stop finishes on a DIFFERENT day (an overnight flight), so
// an arrival is never mistaken for the same morning.
// A stop that STARTS on an earlier day and ENDS on this one is ONE event. It is
// shown here as a read-only continuation banner (never a second stop), so the day
// reads like a calendar without duplicating the event or splitting its data.
function _continuationHtml(dayIdx){
  try{
    if(dayIdx<=0)return '';
    const prev=state.days[dayIdx-1];
    if(!prev||!prev.stops||!prev.stops.length)return '';
    const last=prev.stops[prev.stops.length-1];
    if(!last)return '';
    const ls=_parseTimeMins(last.time),le=_parseTimeMins(last.endTime);
    if(ls==null||le==null||le>=ls)return '';        // did not cross midnight
    const thisISO=dayDateStr(dayIdx);
    const endISO=_endDateOf(last,dayDateStr(dayIdx-1));
    if(thisISO&&endISO&&endISO!==thisISO)return ''; // ends on some other day
    const tz=_endTz(last);
    const dur=_displayDuration(last,dayDateStr(dayIdx-1));
    return '<div style="margin:0 0 12px;padding:10px 13px;border-left:3px solid var(--river,#4a7fa5);background:rgba(74,127,165,0.08);border-radius:0 9px 9px 0;font-family:var(--font-ui);font-size:12.5px;line-height:1.45">'+
      '<div style="font-weight:700;color:var(--river,#4a7fa5);letter-spacing:0.04em;font-size:10.5px;text-transform:uppercase;margin-bottom:2px">Continues from Day '+dayIdx+'</div>'+
      '<div><b>'+_escHtml(last.name||'Travel')+'</b> arrives <b>'+_escHtml(last.endTime||'')+'</b>'+(tz?' '+_escHtml(tz):'')+
      (dur?' &middot; '+_escHtml(dur)+' total':'')+'</div>'+
      '<div style="color:var(--muted);font-size:11px;margin-top:2px">Edit it on Day '+dayIdx+' — it is one event, not a separate stop.</div>'+
    '</div>';
  }catch(e){ return ''; }
}
function _startEndDateHtml(s,dayIdx){
  try{
    const startISO=(s&&s.startDate)||(typeof dayDateStr==='function'?dayDateStr(dayIdx):'');
    if(!startISO)return '';
    const endISO=_endDateOf(s,startISO);
    const sTxt=_fmtShortDate(startISO);
    if(!sTxt)return '';
    const crosses=endISO&&endISO!==startISO;
    const style='display:block;font-size:9.5px;font-weight:600;letter-spacing:0.04em;color:var(--muted);margin-top:2px;white-space:nowrap';
    if(!crosses)return '<span style="'+style+'">'+_escHtml(sTxt)+'</span>';
    return '<span style="'+style+';color:var(--ruby)">'+_escHtml(sTxt)+' &rarr; '+_escHtml(_fmtShortDate(endISO))+(_endTz(s)?' '+_escHtml(_endTz(s)):'')+'</span>';
  }catch(e){ return ''; }
}
// ---- ABSOLUTE INSTANTS (date + time) ---------------------------------------
// The app historically stored a time as MINUTES SINCE MIDNIGHT with no date, so
// 10:00 AM was always "less than" 8:00 PM and an overnight stop looked like it
// ended before it began. These build a real instant — days*1440 + minutes — so a
// start and end can be compared across dates like a calendar does.
function _dayNum(iso){
  if(!iso)return null;
  try{const d=new Date(iso+'T00:00:00');return isNaN(d)?null:Math.round(d.getTime()/86400000);}catch(e){return null;}
}
function _absMins(iso,timeStr){
  const t=_parseTimeMins(timeStr);
  if(t==null)return null;
  const dn=_dayNum(iso);
  return dn==null?t:(dn*1440+t);
}
// A stop's start instant. `dayISO` is the date of the day it sits on.
function _stopStartAbs(s,dayISO){ return _absMins((s&&s.startDate)||dayISO||'',s&&s.time); }
// A stop's end instant. Uses an explicit end date, else infers the next day when
// the end time is earlier on the clock than the start.
function _stopEndAbs(s,dayISO){
  const startISO=(s&&s.startDate)||dayISO||'';
  return _absMins(_endDateOf(s,startISO)||startISO,s&&s.endTime);
}
// ---- CANONICAL TIME I/O -----------------------------------------------------
// A bare "8:30" is ambiguous and was silently read as 8:30 AM, which is how an
// 8:30 PM flight produced a 25h 30min duration and a 5:30 AM airport time. Times
// are entered through a native <input type="time"> (24h, unambiguous) and stored
// in ONE canonical form: "8:30 PM".
function _toTimeInput(str){                    // stored -> "HH:MM" for the input
  const m=_parseTimeMins(str);
  if(m==null)return '';
  return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
}
function _fromTimeInput(val){                  // "20:30" -> "8:30 PM"
  const m=String(val||'').match(/^(\d{1,2}):(\d{2})$/);
  if(!m)return '';
  const h=+m[1],mn=+m[2];
  if(h>23||mn>59)return '';
  return _formatTimeMins(h*60+mn);
}
// Rewrite any parseable time into the canonical form. This never changes WHEN a
// stop is — it only makes the stored value unambiguous, so a wrong AM/PM becomes
// visible instead of silently skewing durations.
// Legacy 'subway' was normalised at a few render call sites but reached
// _suggestStopTime, _legTravelMins, _MAX_MPH and _travelMins raw, where it fell
// through to 'drive' speeds. Canonicalise once on load (no cloud push).
function _canonicalizeTransitModes(){
  if(!state||!state.days)return false;
  let changed=false;
  state.days.forEach(day=>(day.stops||[]).forEach(s=>{
    if(s.transitMode==='subway'){s.transitMode='train';changed=true;}
  }));
  return changed;
}
function _canonicalizeTimes(){
  if(!state||!state.days)return false;
  let changed=false;
  state.days.forEach(day=>(day.stops||[]).forEach(s=>{
    ['time','endTime','flightDepart'].forEach(k=>{
      if(!s[k])return;
      const c=_formatTimeMins(_parseTimeMins(s[k]));
      if(c&&c!==s[k]){s[k]=c;changed=true;}
    });
  }));
  return changed;
}
function _startTz(s){
  if(s&&s.tz)return s.tz;
  const t=(typeof stopTz==='function')?stopTz(s):null;
  return t?(t.abbr||''):'';
}
function _endTz(s){
  if(s&&s.endTz)return s.endTz;
  if(s&&s.destLat&&s.destLng){
    const t=tzData[tzKey(s.destLat,s.destLng)];
    if(t)return t.abbr||'';
  }
  return _startTz(s);
}
// The end DATE. Explicit if set; otherwise the start date, rolled to the next day
// when the end time is earlier on the clock than the start (it crossed midnight).
function _endDateOf(s,startISO){
  if(s&&s.endDate)return s.endDate;
  if(!startISO)return '';
  const st=_parseTimeMins(s&&s.time),et=_parseTimeMins(s&&s.endTime);
  if(st!=null&&et!=null&&et<st){
    try{const d=new Date(startISO+'T00:00:00');d.setDate(d.getDate()+1);return _localISO(d);}catch(e){}
  }
  return startISO;
}
function _fmtShortDate(iso){
  if(!iso)return '';
  try{const d=new Date(iso+'T00:00:00');return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});}catch(e){return '';}
}
// Only http(s) and inline images may be used as an <img src>. A javascript: or
// data:text/html value from the shared cloud DB would otherwise be a live sink.
function _safeImgSrc(u){ return (typeof u==='string'&&/^(https?:|data:image\/)/i.test(u))?u:''; }
function _displayDuration(s,startISO){
  if(!s)return '';
  const st=_parseTimeMins(s.time),et=_parseTimeMins(s.endTime);
  if(st!=null&&et!=null){
    // Use the explicit dates when we have them, so a multi-day leg is measured
    // properly instead of being folded into a single 24-hour wrap.
    let days=0;
    const sISO=s.startDate||startISO||'';
    const eISO=s.endDate||'';
    if(sISO&&eISO){
      try{ days=Math.round((new Date(eISO+'T00:00:00')-new Date(sISO+'T00:00:00'))/86400000); }catch(e){ days=0; }
      if(!(days>=0&&days<=30))days=0;
    }
    let span=(days>0)?(days*1440+et-st):((et>st)?(et-st):(1440-st+et));
    if(span>0&&span<=43200)return _fmtDur(span);
  }
  return s.duration||'';
}
function _stopVisitMins(s){
  const st=_parseTimeMins(s.time),et=_parseTimeMins(s.endTime);
  const span=(st!=null&&et!=null&&et>st)?et-st:null;
  if(span!=null)return span;
  const d=_durationToMins(s.duration);
  if(d!=null)return d;
  return _VISIT_MINS[s.type]??60;
}
// ============================================================================
// PHYSICAL-LOGIC GATE. Objective checks only — "can this be done in the physical
// world?" — never taste/pace ("too rushed", "should you"). Returns a list of
// {rule,msg}. saveState() refuses to persist an itinerary that ADDS any of these.
// ============================================================================
// Fastest even-theoretically-possible sustained speeds (mph) per mode. Anything
// requiring more than this is physically impossible, full stop.
const _MAX_MPH={walk:8,bike:40,drive:90,train:170,bus:90,flight:650};
const _TRAVEL_STOP_TYPES=['drive','flight','train','bus'];
function _logicErrors(st){
  const errs=[];
  if(!st||!Array.isArray(st.days))return errs;
  st.days.forEach((day,di)=>{
    const stops=day.stops||[];
    const D='Day '+(di+1)+': ';
    // (1) Chronological order — a stop can't be scheduled before one listed earlier.
    let lastT=-1,lastName='';
    for(const s of stops){
      const t=_parseTimeMins(s.time);if(t==null)continue;
      if(lastT>=0&&t<lastT)errs.push({rule:'Out of order',msg:D+'"'+s.name+'" ('+s.time+') is scheduled before the earlier stop "'+lastName+'" — the day runs backwards in time.'});
      else{lastT=t;lastName=s.name;}
    }
    // (2) Physical reachability between consecutive LOCATED, timed places. Travel
    //     stops (a drive/flight IS the travel, not a destination) are skipped as
    //     anchors, so we measure real place -> real place and the travel stop's
    //     own time counts toward the gap automatically.
    let prev=null,prevDepart=null;
    for(const s of stops){
      if(_TRAVEL_STOP_TYPES.includes(s.type)||!_validLL(s))continue;
      const t=_parseTimeMins(s.time);if(t==null)continue;
      if(prev&&prevDepart!=null){
        const dist=haversine(prev.lat,prev.lng,s.lat,s.lng);
        if(dist>=1){
          const mode=s.transitMode||_defaultTransitMode(prev,s);
          const mph=_MAX_MPH[mode]||_MAX_MPH.drive;
          const minTravel=Math.round(dist/mph*60);         // fastest possible, ignoring stops/traffic
          const allotted=t-prevDepart;
          if(allotted<minTravel)errs.push({rule:'Impossible travel',msg:D+'"'+s.name+'" ('+s.time+') can’t be reached in time — it is '+Math.round(dist)+' mi from "'+prev.name+'", which takes at least '+minTravel+' min even at top speed, but only '+Math.max(0,allotted)+' min is allowed.'});
        }
      }
      prev=s;
      const e=_parseTimeMins(s.endTime);
      const dur=_durationToMins(s.duration);
      // Departure = the DECLARED end of the visit: an explicit end time, else
      // start + the stop's stated duration. Both are the plan, not a guess. Only
      // when neither is given do we permit leaving immediately (no assumption).
      // (This is the fix for "45-min stop ends 5:15, yet next stop at 5:30".)
      prevDepart=(e!=null&&e>t)?e:(dur!=null&&dur>0?t+dur:t);
    }
    // (3) You cannot be somewhere before you ARRIVE. When a day begins with travel
    //     carried over from the night before (an overnight flight/train/bus, or the
    //     arrival stop derived from one), nothing that day may be scheduled before
    //     that landing time.
    const arr=_dayArrivalMins(di,st);
    if(arr!=null){
      for(const s of stops){
        if(s._arrivalAnchor)continue;                       // the arrival itself
        const t=_parseTimeMins(s.time);if(t==null)continue;
        if(t<arr)errs.push({rule:'Before arrival',msg:D+'"'+s.name+'" ('+s.time+') is scheduled before you land — you do not arrive until '+_formatTimeMins(arr)+'.'});
      }
    }
  });
  return errs;
}
// When does this day's traveller actually ARRIVE, if the day opens with travel
// continuing from the previous day? Returns minutes-since-midnight, or null when
// the day does not begin with a carried-over arrival.
function _dayArrivalMins(di,st){
  try{
    const days=(st&&st.days)?st.days:((typeof state!=='undefined'&&state&&state.days)||[]);
    const day=days[di];if(!day||!day.stops||!day.stops.length)return null;
    // a) An arrival stop sitting at the top of the day (auto-derived or marked).
    const first=day.stops[0];
    if(first&&(first._autoArrival||first._arrivalAnchor)){
      const t=_parseTimeMins(first.time);
      if(t!=null){first._arrivalAnchor=true;return t;}
    }
    // b) The previous day ends with transit that lands the NEXT morning (its end
    //    time is earlier in the clock than its start — it crossed midnight).
    const prevDay=di>0?days[di-1]:null;
    const last=prevDay&&prevDay.stops&&prevDay.stops.length?prevDay.stops[prevDay.stops.length-1]:null;
    if(last&&['flight','train','bus'].includes(last.type)){
      const ls=_parseTimeMins(last.time),le=_parseTimeMins(last.endTime);
      if(ls!=null&&le!=null&&le<ls)return le;               // landed at `le` this morning
    }
    return null;
  }catch(e){ return null; }
}
function _errKey(e){return e.rule+'|'+e.msg;}
function _showLogicError(errs){
  const lines=errs.map(e=>'• '+e.rule+' — '+e.msg).join('\n\n');
  try{alert('⚠️ Change NOT saved — even with zero-length stops it can’t be done in the physical world:\n\n'+lines+'\n\nYour previous itinerary was kept.');}catch(e){}
}
// Try to make a day fit by SHRINKING visit durations (never moving the user's
// stop start times) so each stop is reachable from the previous one. Returns the
// list of stops that were shortened. A leg where even a zero-length visit can't
// make it (travel time alone exceeds the gap) is left for the gate to refuse.
function _relaxDurationsToFit(st){
  const changed=[];
  if(!st||!Array.isArray(st.days))return changed;
  st.days.forEach((day,di)=>{
    const stops=day.stops||[];
    let prev=null;
    for(const s of stops){
      if(_TRAVEL_STOP_TYPES.includes(s.type)||!_validLL(s)){continue;}
      const t=_parseTimeMins(s.time);if(t==null)continue;
      if(prev){
        const pt=_parseTimeMins(prev.time);
        const dist=haversine(prev.lat,prev.lng,s.lat,s.lng);
        if(pt!=null&&dist>=1){
          const mode=s.transitMode||_defaultTransitMode(prev,s);
          const mph=_MAX_MPH[mode]||_MAX_MPH.drive;
          const minTravel=Math.round(dist/mph*60);
          const maxDepart=t-minTravel;            // latest prev can leave and still reach s in time
          const pe=_parseTimeMins(prev.endTime);
          const curDepart=(pe!=null&&pe>pt)?pe:(pt+(_durationToMins(prev.duration)||0));
          if(!prev.locked&&curDepart>maxDepart&&maxDepart>=pt){ // shrinkable: a shorter visit makes it fit
            prev.endTime=_formatTimeMins(maxDepart);
            prev.duration=_fmtDur(maxDepart-pt);
            changed.push({day:di,stop:prev.name,mins:maxDepart-pt});
          }
          // if maxDepart < pt, even a 0-length visit can't fit → leave it for the gate.
        }
      }
      prev=s;
    }
  });
  return changed;
}
function _showDurationAdjustWarning(changed){
  const names=[...new Set(changed.map(c=>c.stop))];
  // showToast writes innerHTML, so stop names (which sync from the shared DB) must be escaped.
  const msg='Shortened '+_escHtml(names.slice(0,3).join(', '))+(names.length>3?' and others':'')+' to fit the travel times.';
  try{ if(typeof showToast==='function')showToast('⏱️ '+msg); else alert('⏱️ '+msg); }catch(e){}
}
// ── Keep day headings & notes in sync with the LIVE stops ───────────────────
function _escRe(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
// A stop's short display name: strip meal/drive prefixes and trailing "— …".
function _shortName(n){
  const s=String(n||'');
  return s.replace(/^\s*(lunch|dinner|breakfast|brunch|drive|check.?in|depart|arrive|fuel stop)\s*[—–:-]\s*/i,'').split(/\s*[—–]\s*/)[0].trim()||s.trim();
}
const _HIGHLIGHT_TYPES=['sight','hike','food','tour','show','beach','shop','museum'];
function _dayHighlights(day,max=3){
  return (day.stops||[]).filter(s=>_HIGHLIGHT_TYPES.includes(s.type)).map(s=>_shortName(s.name)).filter(Boolean).slice(0,max);
}
function _joinTitle(a){ if(!a.length)return''; if(a.length===1)return a[0]; if(a.length===2)return a[0]+' & '+a[1]; return a.slice(0,-1).join(', ')+' & '+a[a.length-1]; }
function _isDateSegment(seg){ return /\b(20\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)\b/i.test(seg||''); }
// Rebuild each day's title/subtitle from the stops actually present, so a heading
// can never keep naming a stop that was removed (which leaked to the AI grader).
// Deterministic, no AI. Runs on render.
function _syncDayHeadings(){
  if(!state||!Array.isArray(state.days))return;
  state.days.forEach(day=>{
    const stops=day.stops||[];if(!stops.length)return;
    const highlights=_dayHighlights(day);
    if(!highlights.length)return;
    const nameHas=(seg)=>stops.some(s=>String(s.name||'').toLowerCase().includes(seg.toLowerCase()));
    // A heading segment is a STALE STOP name if it reads like a place (capitalised,
    // no digits/arrows/# so flight numbers & routes are left alone) and matches no
    // current stop. Only then do we rebuild — editorial text is preserved.
    const staleStop=(seg)=>seg.length>=4&&/^[A-Za-z]/.test(seg)&&!/[\d→#\/]/.test(seg)&&!nameHas(seg);
    if(day.subtitle){
      const segs=day.subtitle.split(/\s*[·•]\s*/).map(x=>x.trim()).filter(Boolean);
      const datePart=(segs[0]&&_isDateSegment(segs[0]))?segs[0]:'';
      const rest=datePart?segs.slice(1):segs;
      if(rest.some(staleStop))day.subtitle=[datePart,...highlights].filter(Boolean).join(' · ');
    }
    const tsegs=(day.title||'').split(/\s*[·•,]\s*|\s+&\s+/).map(x=>x.trim()).filter(Boolean);
    if(tsegs.length>=2&&tsegs.some(staleStop))day.title=_joinTitle(highlights);
  });
}
// When a stop is deleted, remove its name from the day heading and from any
// sentence in OTHER stops' notes that mentions it — so nothing stale lingers.
function _scrubRemovedStop(dayIdx,removedName){
  const day=state.days[dayIdx];if(!day)return;
  const short=_shortName(removedName);
  const tokens=[...new Set([removedName,short,short.split(/\s+/)[0]])].filter(t=>t&&t.length>=4);
  const strip=(text)=>{
    if(!text)return text;let out=text;
    for(const t of tokens){const e=_escRe(t);
      out=out.replace(new RegExp('\\s*[·•,]\\s*'+e+'\\b','gi'),'').replace(new RegExp('\\b'+e+'\\s*(&|and)\\s*','gi'),'').replace(new RegExp('\\s*&\\s*'+e+'\\b','gi'),'').replace(new RegExp('\\b'+e+'\\b','gi'),'');
    }
    return out.replace(/\s{2,}/g,' ').replace(/^[\s·•,&\-—]+/,'').replace(/[\s·•,&\-—]+$/,'').trim();
  };
  if(day.title)day.title=strip(day.title)||day.title;
  if(day.subtitle)day.subtitle=strip(day.subtitle)||day.subtitle;
  (day.stops||[]).forEach(s=>{
    if(!s.notes)return;
    const sentences=s.notes.split(/(?<=[.!?])\s+/);
    const kept=sentences.filter(sen=>!tokens.some(t=>new RegExp('\\b'+_escRe(t)+'\\b','i').test(sen)));
    const cleaned=kept.join(' ').trim();
    if(cleaned&&cleaned!==s.notes)s.notes=cleaned;
  });
}
// ONE-TIME correction of the Scotland Day 7 that the earlier auto-heal corrupted.
// Runs at most once per device (guarded by a flag), replaces the day with the
// user's real itinerary, then never touches it again. NOT a standing feature —
// a single repair. Feasible by construction, so the logic gate accepts it.
const _SCOTLAND_DAY7=[
  {name:'Stirling Castle',type:'hike',time:'9:30 AM',endTime:'10:45 AM',lat:56.1237,lng:-3.9480,notes:'Opens ~9:30 AM. Royal Palace, Great Hall, views over the Forth Valley.'},
  {name:'Lunch — quick bite (Tyndrum)',type:'food',time:'11:45 AM',endTime:'12:05 PM',lat:56.4386,lng:-4.7136,notes:'Quick bite on the A82 heading northwest — keep it short to make the viaduct.'},
  {name:'Glenfinnan Viaduct',type:'hike',time:'1:20 PM',endTime:'2:20 PM',lat:56.8758,lng:-5.4310,notes:'Westbound Jacobite steam train crosses ~1:20 PM — verify exact 2026 times.'},
  {name:'Glencoe',type:'hike',time:'3:15 PM',endTime:'4:15 PM',lat:56.6779,lng:-5.0974,notes:'The Three Sisters — dark, brooding, unforgettable.'},
  {name:'Highland Cattle — Loch Lomond',type:'hike',time:'5:30 PM',endTime:'6:00 PM',lat:56.1006,lng:-4.6389,notes:'Shaggy Highland cattle along Loch Lomond near Luss.'},
  {name:'Glasgow City Walk',type:'hike',time:'7:00 PM',endTime:'8:00 PM',lat:55.8609,lng:-4.2514,notes:'Stroll the Merchant City / George Square.'},
  {name:'Dinner — Café Gandolfi',type:'food',time:'8:15 PM',endTime:'9:30 PM',lat:55.8583,lng:-4.2447,notes:'64 Albion St, Merchant City.'},
  {name:'Hub by Premier Inn Edinburgh',type:'lodge',time:'10:30 PM',endTime:'11:00 PM',lat:55.9525,lng:-3.1986,notes:'Back to Edinburgh for the night.'},
];
// PERMANENTLY DISABLED. This function used to REPLACE the entire Day 7 with a
// hardcoded `_SCOTLAND_DAY7` array whenever that day was infeasible. That is
// destructive: it overwrote the user's real, hand-tuned itinerary (weeks of
// work) on load and pushed the stale copy to the shared cloud. NO auto-heal is
// ever allowed to rewrite a user's stops. It is now a hard no-op that never
// mutates state. Stale-heading cleanup is handled non-destructively by
// _syncDayHeadings() at render time.
function _fixScotlandDay7Once(){ return false; }
// Travel time between two consecutive stops, matching the leg-connector logic.
function _legTravelMins(a,b){
  if(!a||!b)return 15;
  const mode=b.transitMode||_defaultTransitMode(a,b);
  if(a.lat&&a.lng&&b.lat&&b.lng)return Math.max(5,_travelMins(haversine(a.lat,a.lng,b.lat,b.lng),mode));
  return 15;
}
// Recompute every stop's start time in chronological order: each stop begins
// after the previous one's visit duration plus the travel time between them.
// The day's start stays anchored to the earliest existing time (so reordering
// doesn't shift when the day begins). endTime spans move with their start.
// The day's start anchor. This must NEVER return an absurdly-early time — that is
// the bug that made a moved-stop day start at 1:30 AM and then perpetuate itself
// (the corrupted early times became the new anchor every time). Rule: use the
// FIRST stop's time if it's a real start (4:00 AM or later); if the first stop
// has no time, use the earliest real time; otherwise reset the day to 9:00 AM.
function _dayStartAnchor(stops){
  if(!stops||!stops.length)return 540;
  const first=_parseTimeMins(stops[0].time);
  if(first!=null&&first>=240)return first;          // first stop has a genuine (>=4 AM) start
  return 540;                                       // untimed/unparseable/absurd first stop → 9:00 AM.
  // NOTE: never inherit a LATER stop's time as the anchor — that jumped the first
  // stop to noon (and, in older code, wrapped past midnight). 9:00 AM is the sane default.
}
// Heal any day whose (non-transit) first stop is absurdly early — a corruption
// signature — by recomputing its timeline from a sane 9:00 AM start.
// Repair a genuinely corrupt itinerary ONCE, at load — never on every render.
// Order matters: fix broken end times, then broken timelines, then put the day
// in chronological order.
function _healLoadedItinerary(){
  try{ _canonicalizeTransitModes(); }catch(e){}   // legacy 'subway' -> 'train'
  try{ if(_migrateGooglePlacesKey())saveState('Moved Places key off shared state'); }catch(e){}
  try{ _canonicalizeTimes(); }catch(e){}   // make every stored time unambiguous
  try{ _healBadEndTimes(); }catch(e){}
  try{ _healEarlyDays(); }catch(e){}
  try{ _sortAllDaysByTime(); }catch(e){}
}
function _healEarlyDays(){
  if(!state||!state.days)return;
  const TR=['flight','train','bus'];
  state.days.forEach((day,di)=>{
    const stops=day.stops;if(!stops||!stops.length)return;
    const s0=stops[0];
    const ft=_parseTimeMins(s0.time);
    let corrupt=(ft!=null&&ft<240&&!TR.includes(s0.type)); // absurdly early start
    // Times that run BACKWARDS in list order are the wrap-around signature (a bad
    // coordinate's huge travel time pushed the clock past midnight) — recompute.
    if(!corrupt){let last=-1;for(const s of stops){const m=_parseTimeMins(s.time);if(m==null)continue;if(m<last){corrupt=true;break;}last=m;}}
    if(corrupt)_recalcDayTimes(di);
  });
}
// Heal corrupt END times: a normal stop's end must be after its start. An end
// before/equal to the start (e.g. 9:30 AM -> 2:38 AM) is rebuilt from the visit
// duration. Transit legs may cross midnight, so they're left alone.
function _healBadEndTimes(){
  if(!state||!state.days)return;
  const TR=['flight','train','bus'];
  state.days.forEach(day=>{
    (day.stops||[]).forEach(s=>{
      if(TR.includes(s.type)){
        // Transit keeps its own arrival time, but its stored duration must still
        // match start→arrival or the card contradicts itself.
        const ts=_parseTimeMins(s.time),te=_parseTimeMins(s.endTime);
        if(ts!=null&&te!=null){const sp=(te>ts)?(te-ts):(1440-ts+te);if(sp>0&&sp<=1440)s.duration=_fmtDur(sp);}
        return;
      }
      const st=_parseTimeMins(s.time);
      if(st==null)return;              // untimed stop: nothing to compute from
      let et=_parseTimeMins(s.endTime);
      // Make sure a sane end time exists and is after the start. If it's missing
      // or corrupt, seed it from any stored duration, else a per-type default.
      if(et==null||et<=st||et-st>1080){
        const d=_durationToMins(s.duration);
        const span=(d!=null&&d>0&&d<=1080)?d:(_VISIT_MINS[s.type]??60);
        et=st+span;
        s.endTime=_formatTimeMins(et);
      }
      // duration is a CALCULATED field: always the start→end span.
      s.duration=_fmtDur(et-st);
    });
  });
}
// Restore a stop's coordinates (and type) when they've drifted far from the
// KNOWN-CORRECT location for that named stop in the trip's canonical file. This
// undoes the corruption where "Rosslyn Chapel" ended up ~90 mi away near Glencoe,
// which produced a wrong "20 mi" leg AND a misplaced map pin from the one bad
// coordinate. Only the built-in trips have a canonical source; a stop the user
// renamed won't match and is left untouched, and a small deliberate pin nudge
// (< _COORD_DRIFT_MI) is preserved. Runs once on load.
const _COORD_DRIFT_MI=25;
function _normName(n){return String(n||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
// Canonical name → {lat,lng,type} for the current trip, loaded ONCE from its
// built-in file. Cached so the heal can run synchronously at every point where
// `state` is (re)adopted — initial load, background cloud refresh, and the watch
// poll — without a race. Empty object for custom trips (nothing to heal against).
let _canonCoords=null;
async function _loadCanonCoords(){
  if(_canonCoords)return _canonCoords;
  const canon={};
  try{
    if(tripId){
      const res=await fetch('trips/'+tripId+'.json',{cache:'no-store'});
      if(res.ok){
        const base=await res.json();
        const baseDays=Array.isArray(base)?base:base.days;
        (baseDays||[]).forEach(d=>(d.stops||[]).forEach(s=>{
          if(s&&s.name&&_validLL(s)){const k=_normName(s.name);if(!(k in canon))canon[k]={lat:s.lat,lng:s.lng,type:s.type};}
        }));
      }
    }
  }catch(e){}
  _canonCoords=canon;
  return _canonCoords;
}
// Restore any stop whose coordinate drifted >25mi from its known-correct location
// (e.g. Rosslyn Chapel corrupted to ~Glencoe), plus its type. Synchronous; must be
// called on EVERY state adoption so no code path can leave corruption on screen.
// Returns the number of stops fixed.
function _canonFor(name){
  if(!_canonCoords)return null;
  const k=_normName(name);
  if(_canonCoords[k])return _canonCoords[k];
  // Forgiving fallback: a canonical name that clearly refers to the same place
  // (one is a substring of the other), guarded by length so short names can't
  // cross-match. Handles minor renames like "Rosslyn Chapel Visit".
  for(const ck in _canonCoords){
    if(ck.length>=6&&(k.includes(ck)||ck.includes(k)))return _canonCoords[ck];
  }
  return null;
}
function _applyCoordHeal(){
  // DISABLED: this auto-heal matched stops against the built-in trip and wrote
  // its "corrections" back to the cloud, which overwrote real edits and lost a
  // day of work. It must never touch or push user data automatically. Left as a
  // no-op; location fixes are manual ("Fix pin") only.
  return 0;
  /* eslint-disable no-unreachable */
  if(!_canonCoords||!state||!Array.isArray(state.days))return 0;
  let healed=0;
  state.days.forEach(d=>(d.stops||[]).forEach(s=>{
    if(!s||!s.name)return;
    const c=_canonFor(s.name);if(!c)return;
    let fix=false;
    if(_validLL(s)){ if(haversine(s.lat,s.lng,c.lat,c.lng)>_COORD_DRIFT_MI)fix=true; }
    else fix=true;                        // missing / 0,0 coords → restore
    if(fix){
      s.lat=c.lat;s.lng=c.lng;
      // A corrupted coordinate usually came with a corrupted type (Rosslyn → "food").
      if(c.type&&s.type!==c.type)s.type=c.type;
      // destLat/destLng only mean anything for transit legs; a stray one on an
      // activity feeds _patchLegConnectors a wrong distance — drop it.
      if(!['flight','train','bus'].includes(s.type)){ delete s.destLat; delete s.destLng; }
      healed++;
    }
  }));
  return healed;
}
// Caps that keep a recalculated day inside real waking hours no matter how
// corrupt the data is. The killer bug: a stop with a bad coordinate makes the
// travel time to it ~20 HOURS, which pushed the running clock past midnight where
// _formatTimeMins wrapped it into the small hours (2:26 AM). We cap each leg's
// travel and each visit to sane maxima, and NEVER let the clock cross into the
// next morning — so no stop can ever be assigned an absurd overnight time.
const _MAX_LEG_TRAVEL=240;  // 4h — a single day's stops are never 20h of driving apart
const _MAX_VISIT_CASCADE=300; // 5h
const _DAY_END_CAP=1425;    // 23:45 — hard ceiling; the clock never wraps to AM
// Re-time a day AFTER a reorder. RULE: a time the user set is DATA, not a derived
// value. This never invents a new time for a stop the user timed, and never pulls
// a stop EARLIER than they set it — a dinner booked at 6:30 PM stays at 6:30 PM.
// A stop is moved ONLY when its time is physically unreachable (you cannot arrive
// before the previous stop's departure plus the travel time); then it is pushed
// LATER to the earliest time it can actually be reached. Untimed stops carry
// forward from the previous stop, as before.
function _recalcDayTimes(dayIdx,anchorMins){
  const day=state.days[dayIdx];if(!day||!day.stops||!day.stops.length)return;
  const stops=day.stops;
  let fallback=(anchorMins!=null&&anchorMins>=0)?anchorMins:_dayStartAnchor(stops);
  if(fallback>_DAY_END_CAP)fallback=_DAY_END_CAP;
  if(fallback<240)fallback=540;  // HARD CLAMP: a day can never start before 4 AM.
  let cur=fallback;
  for(let i=0;i<stops.length;i++){
    const s=stops[i];
    const oldSt=_parseTimeMins(s.time),oldEt=_parseTimeMins(s.endTime);
    let start;
    if(s.locked&&oldSt!=null){
      // LOCKED (a reservation): this time is fixed. Nothing automatic may move it.
      start=oldSt;
    }else if(i===0){
      // Keep the first stop's own real time; only fall back if it has none.
      start=(oldSt!=null&&oldSt>=240)?oldSt:fallback;
    }else{
      const prev=stops[i-1];
      const visit=Math.min(_stopVisitMins(prev),_MAX_VISIT_CASCADE);
      const travel=Math.min(_legTravelMins(prev,s),_MAX_LEG_TRAVEL);
      const earliest=Math.min(cur+visit+travel,_DAY_END_CAP);
      // KEEP the user's time when it is actually reachable; otherwise push later.
      start=(oldSt!=null&&oldSt>=earliest)?oldSt:earliest;
    }
    start=Math.min(Math.max(start,240),_DAY_END_CAP);
    s.time=_formatTimeMins(start);
    cur=start;
    const isTransit=['flight','train','bus'].includes(s.type);
    if(isTransit){
      // Transit keeps its explicit start→arrival span (arrival time matters).
      if(oldEt!=null){
        let span=(oldSt!=null)?(oldEt-oldSt):null;
        if(span==null||span<=0||span>1080)span=_stopVisitMins(s);
        s.endTime=_formatTimeMins(Math.min(start+Math.min(span,_MAX_VISIT_CASCADE),_DAY_END_CAP));
      }
    }else{
      // Activity: preserve its start→end span; end = new start + span; duration
      // is the calculated mirror of that span.
      let span=(oldSt!=null&&oldEt!=null&&oldEt>oldSt)?(oldEt-oldSt):_stopVisitMins(s);
      span=Math.min(span,_MAX_VISIT_CASCADE);
      const end=Math.min(start+span,_DAY_END_CAP);
      s.endTime=_formatTimeMins(end);
      s.duration=_fmtDur(end-start);
    }
  }
}
// Move a stop up or down one slot. The two stops SWAP TIME SLOTS — nothing else
// in the day is touched. Re-flowing the whole day from an anchor (the old
// behaviour) made one move cascade into every later stop, dragging a 6:30 PM
// dinner around; a move is a swap, so exactly two stops change.
// Each stop keeps its OWN visit length; only the start slot is exchanged.
function moveStop(dayIdx,stopIdx,dir){
  const stops=state.days[dayIdx].stops;
  const newIdx=stopIdx+dir;
  if(newIdx<0||newIdx>=stops.length)return;
  const a=stops[stopIdx],b=stops[newIdx];
  const aStart=_parseTimeMins(a.time),bStart=_parseTimeMins(b.time);
  const canSwap=(aStart!=null&&aStart>=240&&bStart!=null&&bStart>=240);
  if(canSwap){
    const aSpan=Math.min(_stopVisitMins(a),_MAX_VISIT_CASCADE);
    const bSpan=Math.min(_stopVisitMins(b),_MAX_VISIT_CASCADE);
    // A LOCKED stop keeps its reserved time; only the unlocked one takes a new slot.
    if(!a.locked)_setStopSlot(a,bStart,aSpan);
    if(!b.locked)_setStopSlot(b,aStart,bSpan);
  }
  [stops[stopIdx],stops[newIdx]]=[stops[newIdx],stops[stopIdx]];
  // Fill in any stop that has no usable time. Safe to run: _recalcDayTimes keeps
  // every reachable user-set time as-is and only assigns times to untimed stops.
  if(!canSwap||stops.some(s=>{const m=_parseTimeMins(s.time);return m==null||m<240;})){
    _recalcDayTimes(dayIdx,_dayStartAnchor(stops));
  }
  saveState();renderAll();
}
// Place a stop at `start`, preserving its own visit length. Transit keeps its
// arrival span; an activity's duration mirrors start→end.
function _setStopSlot(s,start,span){
  start=Math.min(Math.max(start,240),_DAY_END_CAP);
  s.time=_formatTimeMins(start);
  const end=Math.min(start+span,_DAY_END_CAP);
  if(['flight','train','bus'].includes(s.type)){
    if(_parseTimeMins(s.endTime)!=null)s.endTime=_formatTimeMins(end);
  }else{
    s.endTime=_formatTimeMins(end);
    s.duration=_fmtDur(end-start);
  }
}

function deleteStop(dayIdx,stopIdx){
  const _st=state.days[dayIdx].stops[stopIdx];
  if(!confirm('Remove "'+_st.name+'" from Day '+(dayIdx+1)+'?\n\nThe day heading and any notes on other stops that mention it will be updated too.'))return;
  // If it's an auto-generated overnight arrival, remember the dismissal so it is
  // not immediately regenerated by the sync.
  if(_st&&_st._autoArrival&&typeof _dismissArrival==='function')_dismissArrival(_st.name,_st.time);
  const _removedName=_st?_st.name:'';
  state.days[dayIdx].stops.splice(stopIdx,1);
  try{ _scrubRemovedStop(dayIdx,_removedName); }catch(e){}   // strip the removed stop from heading + other notes
  saveState();renderAll();
}

function setModalMode(isEdit){
  document.querySelector('#modal-overlay .modal-title').textContent=isEdit?'Edit Stop':'Add a Stop';
  document.querySelector('#modal-overlay .btn-primary').textContent=isEdit?'Save Changes':'Add Stop';
}
function openAddStopModal(dayIdx){
  editingStop=null;addingToDay=dayIdx;
  ['place-search','f-name','f-date','f-time','f-endtime','f-duration','f-stars','f-lat','f-lng','f-notes','f-reservation','f-from','f-to','f-airline','f-flightnum','f-url','f-audiourl'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=''});
  document.getElementById('f-date').value=dayDateStr(dayIdx);
  _wireDurationSync();   // End Time <-> Duration stay in step here too
  const _fl0=document.getElementById('f-locked');if(_fl0)_fl0.checked=false;
  ['f-enddate','f-tz','f-endtz'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  const _fi=document.getElementById('f-intl');if(_fi)_fi.value='auto';
  document.getElementById('f-type').value='hike';
  document.getElementById('f-alt').checked=false;
  document.getElementById('search-results').innerHTML='';
  document.getElementById('search-results').classList.remove('open');
  pendingPhoto=null;showPhotoPreview(null);document.getElementById('f-photo').value='';
  pendingTicket=null;pendingTicketName='';showTicketPreview(null);const _ft=document.getElementById('f-ticket');if(_ft)_ft.value='';
  pendingDesc=null;
  const _dd=document.getElementById('f-desc-display');if(_dd)_dd.textContent='';
  const _db=document.getElementById('f-desc-btn');if(_db){_db.textContent='✨ Generate Description';_db.disabled=false;}
  _pendingTransitMode=null;
  document.querySelectorAll('.transit-mode-btn').forEach(b=>b.classList.remove('active'));
  _populateTravelersForm(null);
  setModalMode(false);toggleTransitFields();
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(()=>document.getElementById('place-search').focus(),100);
}
function openEditStopModal(dayIdx,stopIdx){
  editingStop={dayIdx,stopIdx};addingToDay=dayIdx;
  const s=state.days[dayIdx].stops[stopIdx];
  document.getElementById('place-search').value='';
  document.getElementById('f-name').value=s.name||'';
  document.getElementById('f-date').value=dayDateStr(dayIdx);
  document.getElementById('f-time').value=_toTimeInput(s.time);
  document.getElementById('f-type').value=s.type||'hike';
  document.getElementById('f-stars').value=s.stars||'';
  document.getElementById('f-lat').value=s.lat||'';
  document.getElementById('f-lng').value=s.lng||'';
  document.getElementById('f-notes').value=s.notes||'';
  document.getElementById('f-reservation').value=s.reservation||'';
  document.getElementById('f-from').value=s.from||'';
  document.getElementById('f-to').value=s.to||'';
  document.getElementById('f-airline').value=s.airline||'';
  document.getElementById('f-flightnum').value=s.flightNumber||'';
  const _fi=document.getElementById('f-intl');if(_fi)_fi.value=(s.international===true?'1':s.international===false?'0':'auto');
  const _fl=document.getElementById('f-locked');if(_fl)_fl.checked=!!s.locked;
  const _fed=document.getElementById('f-enddate');if(_fed)_fed.value=s.endDate||'';
  const _ftz=document.getElementById('f-tz');if(_ftz)_ftz.value=s.tz||_startTz(s)||'';
  const _fetz=document.getElementById('f-endtz');if(_fetz)_fetz.value=s.endTz||_endTz(s)||'';
  const _fu=document.getElementById('f-url');if(_fu)_fu.value=s.url||'';
  const _fet=document.getElementById('f-endtime');if(_fet)_fet.value=_toTimeInput(s.endTime);
  // Populate Duration from the stop FIRST. It was never set here, so it kept the
  // value from the previously-edited stop whenever the derive below bailed out —
  // which is how a 12:03pm–4:12pm stop showed a stale "2hrs".
  const _fd=document.getElementById('f-duration');if(_fd)_fd.value=s.duration||'';
  _wireDurationSync();    // listeners survive autofill/dictation/paste
  _fSyncDurFromTimes();   // show the derived duration for the loaded start/end
  document.getElementById('f-alt').checked=!!s.alt;
  document.getElementById('search-results').innerHTML='';
  document.getElementById('search-results').classList.remove('open');
  pendingPhoto=s.customImage||null;showPhotoPreview(pendingPhoto);document.getElementById('f-photo').value='';
  pendingTicket=null;pendingTicketName='';const _existTk=s.ticketImage||null;const _existTkMime=_existTk?((_existTk.match(/^data:([^;]+)/)||[])[1]||''):'';showTicketPreview(_existTk,s.ticketFileName||'',_existTkMime?_existTkMime.startsWith('image/'):true);const _ft2=document.getElementById('f-ticket');if(_ft2)_ft2.value='';
  _pendingTransitMode=s.transitMode||null;
  document.querySelectorAll('.transit-mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===_pendingTransitMode));
  _populateTravelersForm(s);
  pendingDesc=null;
  const _dd2=document.getElementById('f-desc-display');if(_dd2)_dd2.textContent=s.desc||'';
  const _db2=document.getElementById('f-desc-btn');if(_db2){_db2.textContent=s.desc?'✨ Regenerate Description':'✨ Generate Description';_db2.disabled=false;}
  setModalMode(true);toggleTransitFields();
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(()=>document.getElementById('f-name').focus(),100);
}

function closeModal(){document.getElementById('modal-overlay').classList.remove('open')}
function toggleTransitFields(){
  const t=document.getElementById('f-type').value;
  const isTransit=['flight','train','bus'].includes(t);
  const isFlight=t==='flight';
  document.getElementById('f-transit-row').style.display=isTransit?'':'none';
  document.getElementById('f-airline-row').style.display=isFlight?'':'none';
  const _intlRow=document.getElementById('f-intl-row');if(_intlRow)_intlRow.style.display=isFlight?'':'none';
  const descSec=document.getElementById('f-desc-section');
  if(descSec)descSec.style.display=isTransit?'none':'';
}
document.getElementById('modal-overlay').addEventListener('click',function(e){if(e.target===this)closeModal()});
document.getElementById('copy-modal').addEventListener('click',function(e){if(e.target===this)closeCopyModal()});

function formatAddress(item){
  const a=item.address||{};
  const city=a.city||a.town||a.village||a.hamlet||a.municipality||'';
  const state=a.state||a.region||a.county||'';
  const country=a.country||'';
  return[city,state,country].filter(Boolean).join(', ');
}

let searchTimer=null;
document.getElementById('place-search').addEventListener('input',function(){
  clearTimeout(searchTimer);
  const q=this.value.trim();
  if(q.length<3){document.getElementById('search-results').classList.remove('open');document.getElementById('search-spinner').classList.remove('active');return}
  document.getElementById('search-spinner').classList.add('active');
  searchTimer=setTimeout(()=>doSearch(q),600);
});

async function doSearch(q){
  const el=document.getElementById('search-results'),sp=document.getElementById('search-spinner');
  try{
    const r=await fetch('https://nominatim.openstreetmap.org/search?q='+encodeURIComponent(q)+'&format=json&limit=6&addressdetails=1',{headers:{'Accept-Language':'en','Accept':'application/json'}});
    sp.classList.remove('active');
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();
    if(!Array.isArray(data)||!data.length){el.innerHTML='<div class="no-results">No results found. Try a different search or enter coordinates manually.</div>';el.classList.add('open');return}
    el.dataset.results=JSON.stringify(data);
    el.innerHTML=data.map((item,i)=>{
      const name=item.name||item.display_name.split(',')[0];
      const addr=formatAddress(item);
      return'<div class="search-result-item" onclick="pickResult('+i+')"><div class="result-name">'+_escHtml(name)+'</div><div class="result-addr">'+_escHtml(addr)+'</div></div>';
    }).join('');
    el.classList.add('open');
  }catch(e){sp.classList.remove('active');el.innerHTML='<div class="no-results">Search unavailable ('+e.message+'). Enter details manually.</div>';el.classList.add('open')}
}

function pickResult(i){
  const data=JSON.parse(document.getElementById('search-results').dataset.results||'[]');
  const r=data[i];if(!r)return;
  const name=r.name||r.display_name.split(',')[0];
  document.getElementById('f-name').value=name;
  document.getElementById('f-lat').value=parseFloat(r.lat).toFixed(5);
  document.getElementById('f-lng').value=parseFloat(r.lon).toFixed(5);
  document.getElementById('place-search').value=name;
  const cls=(r.class||'').toLowerCase(),typ=(r.type||'').toLowerCase();
  let t='hike';
  if(['restaurant','cafe','bar','fast_food','food_court','pub','bakery'].includes(typ))t='food';
  else if(['hotel','motel','hostel','guest_house','chalet','camp_site'].includes(typ))t='lodge';
  else if(cls==='highway'||['motorway','residential','trunk'].includes(typ))t='drive';
  document.getElementById('f-type').value=t;
  document.getElementById('search-results').classList.remove('open');
}

function saveStop(){
  const name=document.getElementById('f-name').value.trim();
  let lat=parseFloat(document.getElementById('f-lat').value);
  let lng=parseFloat(document.getElementById('f-lng').value);
  if(!name){alert('Please enter a stop name.');return}
  // Start Time and End Time are REQUIRED, and the end must be after the start.
  // The inputs are native 24h time pickers; convert to the canonical stored form.
  const _startVal=_fromTimeInput(document.getElementById('f-time')?.value)||(document.getElementById('f-time')?.value||'').trim();
  const _endVal=_fromTimeInput(document.getElementById('f-endtime')?.value)||(document.getElementById('f-endtime')?.value||'').trim();
  const _sMin=_parseTimeMins(_startVal),_eMin=_parseTimeMins(_endVal);
  if(_sMin==null){alert('Please enter a valid Start Time (e.g. 9:00 AM).');return}
  if(_eMin==null){alert('Please enter a valid End Time (e.g. 11:00 AM).');return}
  // Compare real INSTANTS (date + time), not bare clock minutes. Aug 4 8:00 PM ->
  // Aug 5 10:00 AM is a perfectly ordinary overnight stop; only comparing the
  // clock made it look backwards. If no end date was given, an end time earlier
  // on the clock than the start is taken to mean the next day, as a calendar would.
  const _sDate=(document.getElementById('f-date')?.value||'');
  let _eDate=(document.getElementById('f-enddate')?.value||'');
  if(!_eDate&&_sDate&&_eMin<=_sMin){
    try{const d=new Date(_sDate+'T00:00:00');d.setDate(d.getDate()+1);_eDate=_localISO(d);
      const _ed=document.getElementById('f-enddate');if(_ed)_ed.value=_eDate;}catch(e){}
  }
  const _sAbs=_absMins(_sDate,_startVal),_eAbs=_absMins(_eDate||_sDate,_endVal);
  if(_sAbs!=null&&_eAbs!=null&&_eAbs<=_sAbs){
    alert('End must be after the start.\n\nStart: '+(_sDate?_fmtShortDate(_sDate)+' ':'')+_startVal+'\nEnd:   '+((_eDate||_sDate)?_fmtShortDate(_eDate||_sDate)+' ':'')+_endVal+'\n\nIf this stop runs past midnight, set the End Date to the next day.');
    return;
  }
  // Coordinates are OPTIONAL — a stop can be a reservation/note with no location
  // (consistent with AI/imported stops). Only validate them if both were given.
  const hasCoord=!isNaN(lat)&&!isNaN(lng);
  if(hasCoord){
    if(Math.abs(lat)>90&&Math.abs(lng)<=90){[lat,lng]=[lng,lat];}
    if(Math.abs(lat)>90||Math.abs(lng)>180){alert('Coordinates appear invalid. Lat must be -90 to 90, Lng must be -180 to 180.');return}
  }else{ lat=undefined; lng=undefined; }
  const existingStop=editingStop?state.days[editingStop.dayIdx].stops[editingStop.stopIdx]:null;
  const existingPhoto=existingStop?.customImage||null;
  const customImage=pendingPhoto===''?null:(pendingPhoto||existingPhoto||null);
  const existingTicket=existingStop?.ticketImage||null;
  const ticketImage=pendingTicket===''?null:(pendingTicket||existingTicket||null);
  const ticketFileName=pendingTicket===''?undefined:(pendingTicketName||existingStop?.ticketFileName||undefined);
  const stopType=document.getElementById('f-type').value;
  const existingTM=editingStop?state.days[editingStop.dayIdx].stops[editingStop.stopIdx]?.transitMode:null;
  const transitMode=_pendingTransitMode||existingTM||null;
  const attendance=_getAttendanceFromForm();
  const _urlVal=(document.getElementById('f-url')?.value||'').trim()||undefined;
  const _durVal=(document.getElementById('f-duration')?.value||'').trim()||undefined;
  // End Time + Audio URL live in fields injected by trip-extras; read them HERE so
  // they attach to this stop BEFORE the day is re-sorted (previously a wrapper set
  // them by index after the sort, landing them on the wrong stop).
  const _endTimeVal=(document.getElementById('f-endtime')?.value||'').trim()||undefined;
  const _audioVal=(document.getElementById('f-audiourl')?.value||'').trim()||undefined;
  const _intlSel=(document.getElementById('f-intl')?.value)||'auto';
  const _intlVal=stopType==='flight'?(_intlSel==='1'?true:_intlSel==='0'?false:undefined):undefined;
  // PRESERVE EVERYTHING NOT ON THE FORM. Building a fresh object dropped fields the
  // form never shows — _sid (journal notes/ratings key), guidebook, dayHours,
  // dayHoursSrc, destLat/destLng (transit arrival coords) and recentlyChanged —
  // so every edit silently deleted them. Start from the existing stop and let the
  // form-backed fields overwrite it.
  const stop=Object.assign({},existingStop||{},{name,lat,lng,type:stopType,time:_startVal,endTime:_endVal,audioUrl:_audioVal,duration:_durVal,stars:document.getElementById('f-stars').value.trim()||null,notes:document.getElementById('f-notes').value.trim(),reservation:document.getElementById('f-reservation').value.trim()||null,url:_urlVal,from:document.getElementById('f-from').value.trim()||null,to:document.getElementById('f-to').value.trim()||null,airline:stopType==='flight'?(document.getElementById('f-airline').value.trim()||null):null,flightNumber:stopType==='flight'?(document.getElementById('f-flightnum').value.trim()||null):null,international:_intlVal,locked:(document.getElementById('f-locked')?.checked||undefined),startDate:(document.getElementById('f-date')?.value||undefined),endDate:(document.getElementById('f-enddate')?.value||undefined),tz:(document.getElementById('f-tz')?.value.trim()||undefined),endTz:(document.getElementById('f-endtz')?.value.trim()||undefined),flightDepart:stopType==='flight'
      // Keep the ORIGINAL departure unless the user edited the start time.
      // _recalcDayTimes can overwrite a flight's s.time with a later cumulative
      // time, and re-saving then clobbered the very value flightDepart preserves.
      ?((existingStop&&existingStop.flightDepart&&_startVal===existingStop.time)?existingStop.flightDepart:(_startVal||undefined))
      :undefined,alt:document.getElementById('f-alt').checked,customImage,ticketImage:ticketImage||undefined,ticketFileName:ticketFileName||undefined,transitMode:transitMode||undefined,attendance:attendance});
  // Duration is a CALCULATED field for a normal activity: always the start→end
  // span. If the user typed a duration but no end time, derive the end from it;
  // otherwise the two times define the duration and any typed duration is ignored.
  if(!['flight','train','bus'].includes(stopType)){
    const _s=_parseTimeMins(stop.time);
    let _e=_parseTimeMins(stop.endTime);
    if(_s!=null){
      if((_e==null||_e<=_s)){
        const _d=_durationToMins(stop.duration);
        if(_d!=null&&_d>0){ _e=_s+_d; stop.endTime=_formatTimeMins(_e); }
      }
      if(_e!=null&&_e>_s) stop.duration=_fmtDur(_e-_s);
    }
  }
  if(pendingDesc!==null){if(pendingDesc)stop.desc=pendingDesc;}
  else if(existingStop?.desc)stop.desc=existingStop.desc;
  if(existingStop?.openingHours)stop.openingHours=existingStop.openingHours;
  if(existingStop?.website)stop.website=existingStop.website;
  if(existingStop?.phone)stop.phone=existingStop.phone;
  const srcDayIdx=editingStop?editingStop.dayIdx:addingToDay;
  const dateVal=document.getElementById('f-date').value;
  const matched=findDayByDate(dateVal);
  const destDayIdx=matched>=0?matched:srcDayIdx;
  if(editingStop){
    if(destDayIdx===srcDayIdx){
      state.days[srcDayIdx].stops[editingStop.stopIdx]=stop;
    }else{
      state.days[srcDayIdx].stops.splice(editingStop.stopIdx,1);
      state.days[destDayIdx].stops.push(stop);
    }
  }else{
    state.days[destDayIdx].stops.push(stop);
  }
  if(stop.time)_sortDayByTime(destDayIdx);
  saveState();closeModal();
  if(destDayIdx!==currentDayIdx&&destDayIdx>=0){switchDay(destDayIdx);}
  else{renderAll();}
  if(!stop.openingHours)lookupPlaceDetails(stop);
}

/* ---- Audio Tours ---- */
const AUDIO_TOURS={
  'london':[
    {title:'London City Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/britain',duration:'45 min',desc:'Westminster to Trafalgar Square on foot'},
    {title:'British Museum Highlights',provider:'izi.TRAVEL',emoji:'🏛️',url:'https://izi.travel/en/london',duration:'1 hr',desc:'Egyptian mummies, Elgin Marbles, and Rosetta Stone'},
    {title:'Tower of London Self-Guided Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/london-5.html',duration:'1.5 hr',desc:'From Tower Bridge to Traitors\' Gate'},
    {title:'Westminster Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/britain',duration:'30 min',desc:'Parliament, Big Ben, and Westminster Abbey'},
  ],
  'edinburgh':[
    {title:'Edinburgh Old Town Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/britain',duration:'1 hr',desc:'Royal Mile from Castle to Holyrood Palace'},
    {title:'Edinburgh Self-Guided Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/edinburgh-14.html',duration:'1.5 hr',desc:'Medieval closes, wynds, and hidden courtyards'},
    {title:'Edinburgh Castle Audio Tour',provider:'izi.TRAVEL',emoji:'🏰',url:'https://izi.travel/browse/72d7a73e-3ab8-11e4-b1b9-0050568921b6',duration:'45 min',desc:'Scottish Crown Jewels and castle history'},
  ],
  'york':[
    {title:'York City Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/britain',duration:'1 hr',desc:'The Shambles, York Minster, and Roman walls'},
    {title:'York Self-Guided Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/york-1.html',duration:'1 hr',desc:'Medieval shopping street and Viking heritage'},
  ],
  'paris':[
    {title:'Paris Historic Core Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/paris-and-france',duration:'1 hr',desc:'Notre-Dame island to the Seine riverbanks'},
    {title:'Louvre Museum Tour',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/paris-and-france',duration:'1.5 hr',desc:'Mona Lisa, Venus de Milo, and Renaissance masters'},
    {title:'Versailles Self-Guided',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/paris-and-france',duration:'2 hr',desc:'Palace halls, gardens, and Marie Antoinette estate'},
    {title:'Montmartre Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/paris-55.html',duration:'1 hr',desc:'Sacré-Cœur, artists\' quarter, and vineyard views'},
  ],
  'rome':[
    {title:'Rome Neighborhood Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/rome-and-italy',duration:'1 hr',desc:'Piazza Navona, Pantheon, and Trevi Fountain'},
    {title:'Roman Forum Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/rome-and-italy',duration:'45 min',desc:'Ancient Rome\'s civic center explained stop by stop'},
    {title:'Colosseum Audio Guide',provider:'izi.TRAVEL',emoji:'🏛️',url:'https://izi.travel/browse/rome',duration:'1 hr',desc:'Gladiators, spectacles, and Roman engineering'},
    {title:'Vatican Museums Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/rome-53.html',duration:'2 hr',desc:'Sistine Chapel, Raphael Rooms, and classical sculpture'},
  ],
  'florence':[
    {title:'Florence City Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/rome-and-italy',duration:'1 hr',desc:'Duomo to Ponte Vecchio on foot'},
    {title:'Uffizi Gallery Tour',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/rome-and-italy',duration:'1 hr',desc:'Botticelli, da Vinci, and Italian Renaissance masters'},
    {title:'Florence Highlights Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/florence-159.html',duration:'1.5 hr',desc:'Historic center, piazzas, and Medici chapels'},
  ],
  'barcelona':[
    {title:'Barcelona City Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/spain',duration:'1 hr',desc:'Ramblas to the Gothic Quarter'},
    {title:'Sagrada Familia Audio Guide',provider:'izi.TRAVEL',emoji:'🏛️',url:'https://izi.travel/browse/barcelona',duration:'45 min',desc:'Gaudí\'s unfinished masterpiece explained in detail'},
    {title:'Gothic Quarter Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/barcelona-17.html',duration:'1.5 hr',desc:'Medieval streets, Barri Gòtic, and Picasso Museum area'},
  ],
  'amsterdam':[
    {title:'Amsterdam City Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/netherlands',duration:'1 hr',desc:'Central Station to Leidseplein via canal bridges'},
    {title:'Rijksmuseum Audio Tour',provider:'izi.TRAVEL',emoji:'🏛️',url:'https://izi.travel/browse/amsterdam',duration:'1.5 hr',desc:'Rembrandt, Vermeer, and the Dutch Golden Age'},
    {title:'Jordaan Canal Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/amsterdam-34.html',duration:'1 hr',desc:'Anne Frank neighborhood and charming canal houses'},
  ],
  'prague':[
    {title:'Prague Old Town Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/eastern-europe',duration:'1 hr',desc:'Old Town Square, Astronomical Clock, and Charles Bridge'},
    {title:'Prague Castle Audio Tour',provider:'izi.TRAVEL',emoji:'🏰',url:'https://izi.travel/browse/prague',duration:'1 hr',desc:'St. Vitus Cathedral, royal palace, and castle district'},
    {title:'Jewish Quarter Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/prague-39.html',duration:'1.5 hr',desc:'Six synagogues, Old Jewish Cemetery, and Josefov history'},
  ],
  'vienna':[
    {title:'Vienna City Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/eastern-europe',duration:'1 hr',desc:'Stephansplatz to the Hofburg Palace'},
    {title:'Kunsthistorisches Museum Tour',provider:'izi.TRAVEL',emoji:'🏛️',url:'https://izi.travel/browse/vienna',duration:'1 hr',desc:'Habsburg imperial art collection highlights'},
    {title:'Ringstrasse Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/vienna-49.html',duration:'1.5 hr',desc:'Imperial boulevard, opera, parliament, and museums'},
  ],
  'new york':[
    {title:'Manhattan Highlights Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/new-york-city-3.html',duration:'2 hr',desc:'Midtown to Lower Manhattan, Central Park to Brooklyn Bridge'},
    {title:'Metropolitan Museum of Art Tour',provider:'izi.TRAVEL',emoji:'🏛️',url:'https://izi.travel/browse/new-york',duration:'1.5 hr',desc:'Egyptian wing, European masters, and Greek sculpture'},
  ],
  'washington':[
    {title:'Washington D.C. Mall Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/washington-dc-6.html',duration:'2 hr',desc:'Lincoln Memorial, Vietnam Wall, and Smithsonian museums'},
    {title:'National History Museum Tour',provider:'izi.TRAVEL',emoji:'🏛️',url:'https://izi.travel/browse/washington',duration:'1 hr',desc:'Free Smithsonian highlight tour — dinosaurs to Hope Diamond'},
  ],
  'chicago':[
    {title:'Chicago Architecture Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/chicago-10.html',duration:'1.5 hr',desc:'Loop skyline, skyscrapers, and famous bridges'},
    {title:'Art Institute of Chicago Tour',provider:'izi.TRAVEL',emoji:'🏛️',url:'https://izi.travel/browse/chicago',duration:'1 hr',desc:'Seurat\'s Sunday Afternoon, Monet, and American Modernism'},
  ],
  'san francisco':[
    {title:'San Francisco City Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/san-francisco-8.html',duration:'1.5 hr',desc:'Fisherman\'s Wharf, Chinatown, and North Beach'},
    {title:'Golden Gate Bridge Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/san-francisco-8.html',duration:'1 hr',desc:'Bridge history, views, and the Presidio park'},
  ],
  'new orleans':[
    {title:'French Quarter Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/new-orleans-12.html',duration:'1.5 hr',desc:'Jackson Square, Bourbon Street history, and Creole architecture'},
    {title:'Garden District Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/new-orleans-12.html',duration:'1 hr',desc:'Antebellum mansions, Lafayette Cemetery, and Anne Rice country'},
  ],
  'tokyo':[
    {title:'Asakusa Historic Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/tokyo-35.html',duration:'1.5 hr',desc:'Senso-ji Temple, Nakamise shopping street, and old shitamachi'},
    {title:'Senso-ji Temple Audio Guide',provider:'izi.TRAVEL',emoji:'🏛️',url:'https://izi.travel/browse/tokyo',duration:'30 min',desc:'Tokyo\'s oldest Buddhist temple — history and ritual explained'},
  ],
  'kyoto':[
    {title:'Kyoto Highlights Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/kyoto-36.html',duration:'2 hr',desc:'Fushimi Inari, Gion geisha district, and Nishiki Market'},
    {title:'Arashiyama Bamboo Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/kyoto-36.html',duration:'1 hr',desc:'Bamboo groves, Tenryu-ji garden, and Togetsukyo Bridge'},
  ],
  'sydney':[
    {title:'Sydney Harbour Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/sydney-42.html',duration:'2 hr',desc:'Opera House, Harbour Bridge, and The Rocks colonial history'},
    {title:'The Rocks Historic Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/sydney-42.html',duration:'1 hr',desc:'Sandstone laneways, convict history, and Circular Quay'},
  ],
  'dublin':[
    {title:'Dublin City Walk',provider:'Rick Steves',emoji:'🎙️',url:'https://www.ricksteves.com/watch-read-listen/audio/audio-tours/britain',duration:'1 hr',desc:'Trinity College to St. Patrick\'s Cathedral'},
    {title:'Temple Bar & Docklands Walk',provider:'GPSmyCity',emoji:'🗺️',url:'https://www.gpsmycity.com/city-guides/dublin-23.html',duration:'1.5 hr',desc:'Georgian squares, Viking heritage, and pub culture'},
    {title:'National Museum of Ireland Tour',provider:'izi.TRAVEL',emoji:'🏛️',url:'https://izi.travel/browse/dublin',duration:'45 min',desc:'Celtic gold, Viking artifacts, and Irish history'},
  ],
};
const _AUDIO_GENERIC=new Set(['the','and','for','with','from','this','that','stop','visit','tour','walk','hike','drive','hotel','check','arrive','depart','flight','train','lunch','dinner','breakfast','evening','morning','museum','palace','castle','church','cathedral','park','market','square','bridge','street','district','quarter','village','town','city','centre','center','national','historic','old','new']);
function _audioBadgeHtml(s){
  if(['drive','flight','train','bus','lodge'].includes(s.type))return'';
  const stored=(state.audioTours||[]);
  if(!stored.length)return'';
  const stopWords=(s.name||'').toLowerCase().split(/\W+/).filter(w=>w.length>=4&&!_AUDIO_GENERIC.has(w));
  if(!stopWords.length)return'';
  const match=stored.find(t=>{
    const hay=(t.title+' '+(t.desc||'')).toLowerCase();
    return stopWords.some(w=>hay.includes(w));
  });
  if(!match)return'';
  const item='<div class="audio-tour-item">'+
    '<div class="audio-tour-item-title">'+_escHtml(match.title)+'</div>'+
    '<div class="audio-tour-item-meta">'+_escHtml(match.provider)+(match.duration?' · '+match.duration:'')+'</div>'+
    '<a class="audio-tour-item-link" href="'+_escHtml(match.url)+'" target="_blank" rel="noopener">&#9654; Open Tour</a>'+
    '</div>';
  return'<span class="audio-badge" onclick="this.classList.toggle(\'open\');event.stopPropagation()">&#127911; Tour<div class="audio-popover"><div class="audio-popover-title">&#127911; Audio Tour</div>'+item+'</div></span>';
}
function _audioTourCardHtml(t){
  return'<div class="audio-tour-card">'+
    '<div class="audio-provider-icon">'+(t.emoji||'&#127911;')+'</div>'+
    '<div class="audio-tour-info">'+
    '<div class="audio-tour-name">'+_escHtml(t.title||'')+'</div>'+
    '<div class="audio-tour-provider">'+_escHtml(t.provider||'')+(t.city?' &middot; '+_escHtml(t.city):'')+'</div>'+
    (t.desc?'<div class="audio-tour-desc">'+_escHtml(t.desc)+'</div>':'')+
    '<div class="audio-tour-actions">'+
    (t.url?'<a class="audio-open-btn" href="'+_escHtml(t.url)+'" target="_blank" rel="noopener">&#9654; Open Tour</a>':'')+
    (t.duration?'<span class="audio-dur">&#9201; '+_escHtml(t.duration)+'</span>':'')+
    '</div></div></div>';
}
function renderAudioToursHtml(){
  const tours=state.audioTours||[];
  const discoverBtn='<button class="audio-discover-btn" id="audio-discover-btn" onclick="findAudioToursWithAI()">&#10024; '+(tours.length?'Find More Audio Tours':'Find Audio Tours with AI')+'</button><div id="audio-discover-result"></div>';
  if(!tours.length){
    return'<div class="ov-empty" style="margin-bottom:16px">No audio tours saved yet. Let AI find self-guided walking tours and museum guides for your destinations.</div>'+discoverBtn;
  }
  const byCity={};
  tours.forEach(t=>{const c=(t.city||'').toLowerCase();if(!byCity[c])byCity[c]=[];byCity[c].push(t);});
  let h='';
  Object.entries(byCity).forEach(([city,cts])=>{
    h+='<div class="audio-city-hdr">&#127911; '+city.charAt(0).toUpperCase()+city.slice(1)+'</div>';
    cts.forEach(t=>{h+=_audioTourCardHtml(t);});
  });
  h+=discoverBtn;
  return h;
}
const AUDIO_FIND_SYSTEM='You are a travel audio tour expert. Find real, available self-guided audio tours for the requested destinations. Return ONLY a valid JSON array, no markdown, no extra text.\nFormat: [{"city":"london","title":"Tour Name","provider":"Rick Steves","emoji":"🎙️","url":"https://www.ricksteves.com/watch-read-listen/audio/audio-tours/britain","duration":"45 min","desc":"One sentence description of what the tour covers"}]\nRules:\n- Use ONLY real tours from Rick Steves (ricksteves.com), GPSmyCity (gpsmycity.com city guide pages), or official museum audio guides\n- Rick Steves URL must be one of: https://www.ricksteves.com/watch-read-listen/audio/audio-tours/britain OR /paris-and-france OR /rome-and-italy OR /spain OR /eastern-europe OR /netherlands\n- GPSmyCity URLs: use https://www.gpsmycity.com/city-guides/CITY-NUM.html format (real city page numbers)\n- Return 2-4 tours per destination city\n- desc must mention specific landmarks covered';
async function findAudioToursWithAI(){
  const btn=document.getElementById('audio-discover-btn');
  const result=document.getElementById('audio-discover-result');
  if(btn){btn.disabled=true;btn.textContent='Finding tours…';}
  const cities=[...new Set(state.days.map(d=>d.title.replace(/^Day \d+\s*[—–]\s*/,'')).filter(Boolean))].slice(0,8).join(', ');
  try{
    const text=await callClaude(AUDIO_FIND_SYSTEM,'Find audio tours for a trip visiting: '+cities);
    const t=text.trim().replace(/```(?:json)?/gi,'').replace(/```/g,'').trim();
    const js=t.indexOf('['),je=t.lastIndexOf(']');
    const tours=JSON.parse(js>=0&&je>js?t.slice(js,je+1):t);
    if(!Array.isArray(tours)||!tours.length)throw new Error('No tours returned');
    if(!state.audioTours)state.audioTours=[];
    tours.forEach(t=>{if(t.title&&!state.audioTours.find(e=>e.title===t.title))state.audioTours.push(t);});
    saveState('Found audio tours with AI');
    const panel=document.getElementById('ovtab-audio');
    if(panel)panel.innerHTML=renderAudioToursHtml();
  }catch(e){
    if(result)result.innerHTML='<div style="color:var(--ruby);font-family:var(--font-ui);font-size:13px;margin-top:8px">Could not find tours — please try again.</div>';
    if(btn){btn.disabled=false;btn.innerHTML='&#10024; Find Audio Tours with AI';}
  }
}

/* ---- Overview ---- */
const DISMISSED_KEY='dismissed_chk_'+tripId;
function _getDismissed(){try{return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY)||'[]'))}catch(e){return new Set();}}
function _addDismissed(id){let a;try{a=JSON.parse(localStorage.getItem(DISMISSED_KEY)||'[]')}catch(e){a=[];}if(!a.includes(id))a.push(id);try{localStorage.setItem(DISMISSED_KEY,JSON.stringify(a))}catch(e){}}

function _chkItemHtml(item){
  const done=item.done;
  return'<div class="check-item'+(done?' done':'')+'" id="chk-'+item.id+'">' +
    '<input type="checkbox" '+(done?'checked':'')+' onchange="toggleCheckItem(\''+item.id+'\',this.checked)"/>'+
    '<span class="check-text">'+_escHtml(item.text||'')+'</span>'+
    '<div class="chk-actions">'+
    '<button class="chk-edit-btn" onclick="startEditCheckItem(\''+item.id+'\')" title="Edit">&#9998;</button>'+
    '<button class="chk-del" onclick="deleteCheckItem(\''+item.id+'\')" title="Remove">&times;</button>'+
    '</div></div>';
}

function _fmtDateWithYear(str){
  if(!str)return str;
  const d=_parseTripDate(str)||new Date(str+' 12:00'); // infer the correct year, not the current one
  if(isNaN(d))return str;
  return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
}
function _fmtSubtitle(subtitle){
  if(!subtitle)return subtitle;
  const parts=subtitle.split(/\s*[·•]\s*/);
  parts[0]=_fmtDateWithYear(parts[0]);
  return parts.join(' · ');
}
function _dayDateLabel(di){
  const sub=(state.days[di]?.subtitle||'').split(/\s*[·•]\s*/)[0].trim();
  return _fmtDateWithYear(sub);
}

function generateChecklist(){
  const dismissed=_getDismissed();
  const prev={};
  (state.checklist||[]).filter(i=>i.auto).forEach(i=>{prev[i.id]=i.done});
  const CK_KW=/pre-?book|book in advance|book now|sells out|timed entry|timed slot/i;
  const typePri={flight:0,train:1,lodge:2,hike:3,food:4,drive:5};
  const bookable=[];const seen=new Set();

  /* — Deduplicate lodge stops by name: group all nights for same hotel — */
  const lodgeGroups={};
  state.days.forEach((d,di)=>{
    d.stops.forEach((s,si)=>{
      if(s.type!=='lodge'||/^depart\b/i.test(s.name))return;
      const nm=s.name.replace(/^check.?in\s*[—–\-]\s*/i,'').replace(/\s*[—–].*/,'').trim()||s.name;
      const key='auto-bk-lodge-'+nm.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,25);
      if(!lodgeGroups[key])lodgeGroups[key]={nm,key,days:[],reservation:null};
      lodgeGroups[key].days.push({di,si,s});
      if(s.reservation&&!lodgeGroups[key].reservation)lodgeGroups[key].reservation=s.reservation;
    });
  });
  Object.values(lodgeGroups).forEach(g=>{
    const {nm,key,days,reservation}=g;
    seen.add(key);
    if(dismissed.has(key))return;
    let dateLabel='';
    if(days.length>1){
      const f=_dayDateLabel(days[0].di),l=_dayDateLabel(days[days.length-1].di);
      if(f&&l&&f!==l)dateLabel=' ('+f+'–'+l+')';
      else if(f)dateLabel=' ('+f+')';
    }
    const isDone=key in prev?prev[key]:!!reservation;
    let text='Hotel: '+nm+(reservation?' · '+reservation:'')+dateLabel;
    bookable.push({id:key,text,done:isDone,auto:true,pri:2,di:days[0].di,si:days[0].si,urgent:false});
  });

  /* — Flights, trains, keyword-bookable — */
  state.days.forEach((d,di)=>{
    d.stops.forEach((s,si)=>{
      if(/^depart\b/i.test(s.name)||s.type==='lodge')return;
      const needs=s.reservation||['flight','train'].includes(s.type)||CK_KW.test(s.notes||'');
      if(!needs)return;
      const nm=s.name.replace(/^check.?in\s*[—–\-]\s*/i,'').replace(/\s*[—–].*/,'').trim()||s.name;
      if(!s.reservation){
        if(s.type==='flight'&&/^(land at|arrive |arrival)/i.test(nm))return;
        if(s.type==='flight'&&/check.?in/i.test(s.name))return;
        if(/^(train|flight|drive|walk|bus|taxi|tube|metro|ferry|subway)$/i.test(nm))return;
      }
      const key='auto-bk-'+s.type+'-'+nm.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,25);
      if(seen.has(key))return;seen.add(key);
      if(dismissed.has(key))return;
      const isDone=key in prev?prev[key]:!!s.reservation;
      let text;
      if(s.type==='flight')text='Flight: '+nm+(s.reservation?' · '+s.reservation:'');
      else if(s.type==='train')text='Train: '+nm+(s.reservation?' · Ref '+s.reservation:'');
      else text='Book: '+nm;
      const urgent=/sells out|BOOK TIMED|BOOK NOW/i.test(s.notes||'');
      if(urgent)text='⚠️ '+text;
      bookable.push({id:key,text,done:isDone,auto:true,pri:typePri[s.type]??3,di,si,urgent});
    });
  });

  bookable.sort((a,b)=>{
    if(a.urgent!==b.urgent)return a.urgent?-1:1;
    if(a.pri!==b.pri)return a.pri-b.pri;
    return a.di-b.di||a.si-b.si;
  });
  if(bookable.length===0){
    const items=[];
    const hasF=state.days.some(d=>d.stops.some(s=>s.type==='flight'));
    const hasT=state.days.some(d=>d.stops.some(s=>s.type==='train'));
    if(hasF){
      if(!dismissed.has('auto-flights'))items.push({id:'auto-flights',text:'Book flights',done:prev['auto-flights']||false,auto:true});
      if(!dismissed.has('auto-car'))items.push({id:'auto-car',text:'Reserve rental car',done:prev['auto-car']||false,auto:true});
    }
    if(hasT&&!dismissed.has('auto-trains'))items.push({id:'auto-trains',text:'Book train tickets',done:prev['auto-trains']||false,auto:true});
    if(!dismissed.has('auto-insurance'))items.push({id:'auto-insurance',text:'Review travel insurance',done:prev['auto-insurance']||false,auto:true});
    return[...items,...(state.checklist||[]).filter(i=>!i.auto)];
  }
  return[...bookable,...(state.checklist||[]).filter(i=>!i.auto)];
}

function renderOverview(){
  state.checklist=generateChecklist();
  const totalStops=state.days.reduce((n,d)=>n+d.stops.length,0);
  const lodges=[];
  state.days.forEach((day,di)=>day.stops.forEach(s=>{if(s.type==='lodge')lodges.push({di,day,s});}));

  const statsHtml='<div class="ov-stats">'+
    '<div class="ov-stat"><div class="ov-stat-num">'+state.days.length+'</div><div class="ov-stat-label">Days</div></div>'+
    '<div class="ov-stat"><div class="ov-stat-num">'+totalStops+'</div><div class="ov-stat-label">Stops</div></div>'+
    '<div class="ov-stat"><div class="ov-stat-num">'+lodges.length+'</div><div class="ov-stat-label">Nights</div></div>'+
    '</div>';

  const colors=['var(--ruby)','var(--pine)','var(--river)','var(--amber)'];
  const calHtml=state.days.map((day,di)=>{
    const theme=day.title.replace(/^Day \d+\s*[—–]\s*/,'');
    const datePart=day.subtitle?day.subtitle.split(/\s*[·•]\s*/)[0].trim():'';
    const dayConflicts=detectConflicts(di);
    const hasConflict=Object.keys(dayConflicts).length>0;
    return'<div class="cal-card" onclick="switchDay('+di+')" style="border-left:3px solid '+colors[di%4]+'">'+
      '<div class="cal-day-num">Day '+(di+1)+'</div>'+
      (datePart?'<div class="cal-date">'+_fmtDateWithYear(datePart)+'</div>':'')+
      '<div class="cal-theme">'+_escHtml(theme)+'</div>'+
      '<div class="cal-stop-count">'+day.stops.length+' stop'+(day.stops.length!==1?'s':'')+'</div>'+
      (hasConflict?'<div class="cal-conflict-dot" title="Timing issues detected">&#9888;</div>':'')+
      '</div>';
  }).join('');

  const lodgeHtml=lodges.length?lodges.map(({di,day,s})=>{
    const nm=s.name.replace(/^check.?in\s*[—–\-]\s*/i,'').replace(/\s*[—–].*/,'').trim()||s.name;
    const id='auto-bk-lodge-'+nm.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,25);
    const booked=(state.checklist||[]).find(c=>c.id===id)?.done||false;
    const datePart=day.subtitle?day.subtitle.split(/\s*[·•]\s*/)[0].trim():'';
    return'<div class="lodge-card">'+
      '<div class="lodge-night-badge"><span class="lodge-night">Night '+(di+1)+'</span>'+(datePart?'<span class="lodge-date">'+_fmtDateWithYear(datePart)+'</span>':'')+'</div>'+
      '<div class="lodge-info"><div class="lodge-name">'+_escHtml(nm)+(s.reservation||booked?'<span class="badge-booked-sm">&#10003; Booked</span>':'')+'</div>'+(s.notes?'<div class="lodge-notes">'+_escHtml(s.notes)+'</div>':'')+'</div>'+
      '<label class="lodge-booked"><input type="checkbox" '+(booked?'checked':'')+' onchange="toggleCheckItem(\''+id+'\',this.checked)"/> Booked</label>'+
      '</div>';
  }).join(''):'<div class="ov-empty">No lodging stops yet. Add stops with type "Lodging" to see them here.</div>';

  const checkHtml=state.checklist.map(item=>_chkItemHtml(item)).join('');

  let budgetHtml='';
  if(state.budget&&state.budget.total){
    const bTotal=state.budget.type==='total'?state.budget.total:state.budget.total*state.days.length;
    const bPerDay=state.budget.type==='total'?Math.round(bTotal/state.days.length):state.budget.total;
    budgetHtml='<div class="budget-ov-card" style="margin-top:12px">'+
      '<div class="budget-ov-num">$'+Math.round(bTotal).toLocaleString()+'</div>'+
      '<div class="budget-ov-meta">Total budget · $'+bPerDay.toLocaleString()+'/day</div>'+
      '</div>';
  }

  const jnl=isJournalMode();
  const bookedCount=state.checklist.filter(i=>i.done).length;
  const totalBook=state.checklist.length;
  let activeOvTab='calendar';
  try{activeOvTab=sessionStorage.getItem('ov_tab_'+tripId)||'calendar';}catch(e){}
  const tabs=[['calendar','&#128197; Calendar'],['lodging','&#127970; Staying'],['checklist','&#9989; Checklist'],['packing','&#127890; Packing'],['audio','&#127911; Audio Tours']];
  const tabBar='<div class="ov-tab-bar">'+tabs.map(([id,label])=>'<button class="ov-tab'+(activeOvTab===id?' active':'')+'" data-tab="'+id+'" onclick="switchOvTab(\''+id+'\')">'+label+'</button>').join('')+'</div>';

  const panelCal='<div class="ov-tab-panel" id="ovtab-calendar"'+(activeOvTab!=='calendar'?' style="display:none"':'')+'>'+
    '<div class="cal-grid">'+calHtml+'</div></div>';
  const panelLodge='<div class="ov-tab-panel" id="ovtab-lodging"'+(activeOvTab!=='lodging'?' style="display:none"':'')+'>'+
    '<div class="lodge-list">'+lodgeHtml+'</div></div>';
  const panelCheck='<div class="ov-tab-panel" id="ovtab-checklist"'+(activeOvTab!=='checklist'?' style="display:none"':'')+'>'+
    (totalBook?'<div class="checklist-count" id="checklist-count">'+bookedCount+' of '+totalBook+' bookings confirmed</div>':'')+
    '<div class="check-list">'+checkHtml+'</div>'+
    '<div id="add-check-form" class="add-check-form">'+
    '<div class="add-check-form-row">'+
    '<input type="text" id="new-check-input" class="add-check-input" placeholder="Item to book or pack…" style="flex:1;min-width:0" onkeydown="if(event.key===\'Enter\')addCheckItem()"/>'+
    '<select id="new-check-type" class="add-check-form-select"><option value="">Type…</option><option value="Flight">Flight</option><option value="Hotel">Hotel</option><option value="Train">Train</option><option value="Activity">Activity</option><option value="Other">Other</option></select>'+
    '</div>'+
    '<div class="add-check-form-row">'+
    '<input type="text" id="new-check-resv" class="add-check-input" placeholder="Reservation # (optional)" style="flex:1;min-width:0" onkeydown="if(event.key===\'Enter\')addCheckItem()"/>'+
    '<button class="add-check-btn" onclick="addCheckItem()">&#10003; Add</button>'+
    '<button class="btn-cancel" style="padding:9px 14px;font-size:13px" onclick="hideAddCheckForm()">Cancel</button>'+
    '</div></div>'+
    '<div id="add-check-toggle"><button class="add-check-toggle-btn" onclick="showAddCheckForm()">+ Add Item</button></div>'+
    '</div>';
  const panelPack='<div class="ov-tab-panel" id="ovtab-packing"'+(activeOvTab!=='packing'?' style="display:none"':'')+'>'+
    renderPackingListHtml()+
    (_gpKey()?'':'<div style="font-family:var(--font-ui);font-size:12px;color:var(--muted);padding:10px 14px;background:var(--mist);border-radius:var(--radius-md);border:1px dashed var(--border);margin-top:12px">&#128269; <strong>Tip:</strong> Add a <a href="#" onclick="promptGoogleKey();return false" style="color:var(--river)">Google Places API key</a> in settings to auto-populate opening hours and websites for stops.</div>')+
    '</div>';
  const panelAudio='<div class="ov-tab-panel" id="ovtab-audio"'+(activeOvTab!=='audio'?' style="display:none"':'')+'>'+
    renderAudioToursHtml()+'</div>';

  const startIso=dayDateStr(0);
  const startDateHtml='<div class="ov-start-date">&#128197; Starts: '+
    '<input type="date" id="ov-start-input" value="'+startIso+'" onchange="setTripStartDate(this.value)"/>'+
    (startIso?'':'<span style="color:var(--muted);font-size:12px"> (pick a date to set day dates)</span>')+
    '</div>';

  return'<div class="ov-panel">'+
    '<div class="ov-section">'+
    (state.title?'<div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">'+
    '<div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1">'+
    '<div class="ov-trip-name" style="margin-bottom:0">'+_escHtml(state.title)+'</div>'+
    '<button onclick="renameTripPrompt()" title="Rename trip" style="background:none;border:none;cursor:pointer;font-size:15px;padding:2px 5px;color:var(--muted);line-height:1;flex-shrink:0" aria-label="Rename trip">&#9998;</button>'+
    '</div>'+
    '<div style="display:flex;gap:8px;flex-shrink:0;align-items:center">'+
    '<button class="ai-action-btn" onclick="gradeItinerary()">&#10024; Grade</button>'+
    '<button class="ai-action-btn" onclick="generateGuidebook()">&#128366; Guidebook</button>'+
    (jnl?'<button class="ai-action-btn" onclick="openTripRecap()" style="background:var(--amber)">&#128196; Recap</button>':'')+
    '<button class="ai-action-btn" onclick="openShareModal()" style="background:var(--pine)">&#128279; Share</button>'+
    '<button class="ai-action-btn" onclick="openTravelersModal()" style="background:var(--slate,#4A6572)">&#128100; Travelers</button>'+
    '<button class="ai-action-btn" id="offline-btn" onclick="downloadTripOffline()" style="background:var(--river)" title="Download this itinerary so you can view it without internet">'+(localStorage.getItem("offline_"+tripId)==="1"?"&#10003; Saved Offline":"&#11015; Save Offline")+'</button>'+
    '<button class="ai-action-btn" onclick="deleteTripFromView()" style="background:var(--ruby)">&#128465; Delete</button>'+
    '</div></div>':'')
    +startDateHtml+statsHtml+budgetHtml+'</div>'+
    (jnl?_tripHighlightsHtml():'')+
    renderUnbookedSection()+
    tabBar+panelCal+panelLodge+panelCheck+panelPack+panelAudio+
    '</div>';
}
function switchOvTab(id){
  ['calendar','lodging','checklist','packing','audio'].forEach(t=>{
    const p=document.getElementById('ovtab-'+t);
    if(p)p.style.display=t===id?'':'none';
  });
  document.querySelectorAll('.ov-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===id));
  try{sessionStorage.setItem('ov_tab_'+tripId,id);}catch(e){}
}

function _updateChecklistCount(){
  const el=document.getElementById('checklist-count');if(!el)return;
  const done=(state.checklist||[]).filter(i=>i.done).length;
  const total=(state.checklist||[]).length;
  if(total===0){el.style.display='none';return;}
  el.style.display='';el.textContent=done+' of '+total+' bookings confirmed';
}
function toggleCheckItem(id,done){
  const item=(state.checklist||[]).find(i=>i.id===id);
  if(item){item.done=done;saveState();}
  const el=document.getElementById('chk-'+id);
  if(el){el.classList.toggle('done',done);const cb=el.querySelector('input[type=checkbox]');if(cb)cb.checked=done;}
  _updateChecklistCount();
  // keep any duplicate control for the same item (e.g. the lodge-card "Booked" box) in sync
  document.querySelectorAll('input[type=checkbox][onchange*="toggleCheckItem(\''+id+'\'"]').forEach(cb=>{cb.checked=done;});
}
function showAddCheckForm(){
  const form=document.getElementById('add-check-form');
  const tog=document.getElementById('add-check-toggle');
  if(form)form.classList.add('open');
  if(tog)tog.style.display='none';
  setTimeout(()=>document.getElementById('new-check-input')?.focus(),50);
}
function hideAddCheckForm(){
  const form=document.getElementById('add-check-form');
  const tog=document.getElementById('add-check-toggle');
  if(form)form.classList.remove('open');
  if(tog)tog.style.display='';
}
function addCheckItem(){
  const input=document.getElementById('new-check-input');
  const typeEl=document.getElementById('new-check-type');
  const resvEl=document.getElementById('new-check-resv');
  const label=(input?input.value.trim():'');if(!label)return;
  const type=typeEl?typeEl.value:'';
  const resv=resvEl?resvEl.value.trim():'';
  if(!state.checklist)state.checklist=[];
  const id='custom-'+Date.now();
  let text=type&&type!=='Other'?type+': '+label:label;
  if(resv)text+=' · '+resv;
  const item={id,text,done:false,auto:false};
  state.checklist.push(item);saveState();
  if(input)input.value='';if(typeEl)typeEl.value='';if(resvEl)resvEl.value='';
  const list=document.querySelector('.check-list');
  if(list)list.insertAdjacentHTML('beforeend',_chkItemHtml(item));
  _updateChecklistCount();
  hideAddCheckForm();
}
function deleteCheckItem(id){
  const item=(state.checklist||[]).find(i=>i.id===id);
  const el=document.getElementById('chk-'+id);if(!el)return;
  const doneProp=item&&item.done;
  el.innerHTML=
    '<input type="checkbox" '+(doneProp?'checked':'')+' disabled/>'+
    '<span class="check-text" style="color:var(--muted);font-style:italic">Remove this item?</span>'+
    '<div class="chk-actions" style="opacity:1">'+
    '<button class="add-check-btn" style="padding:4px 10px;font-size:12px;background:var(--ruby);white-space:nowrap" onclick="confirmDeleteCheckItem(\''+id+'\')">Yes, remove</button>'+
    '<button class="chk-edit-btn" style="color:var(--muted);font-size:12px;padding:0 6px" onclick="cancelDeleteCheckItem(\''+id+'\')">No</button>'+
    '</div>';
}
function confirmDeleteCheckItem(id){
  const item=(state.checklist||[]).find(i=>i.id===id);
  if(item&&item.auto)_addDismissed(id);
  state.checklist=(state.checklist||[]).filter(i=>i.id!==id);saveState();
  const el=document.getElementById('chk-'+id);if(el)el.remove();
  _updateChecklistCount();
}
function cancelDeleteCheckItem(id){
  const item=(state.checklist||[]).find(i=>i.id===id);if(!item)return;
  const el=document.getElementById('chk-'+id);if(el)el.outerHTML=_chkItemHtml(item);
}
function startEditCheckItem(id){
  const item=(state.checklist||[]).find(i=>i.id===id);if(!item)return;
  const el=document.getElementById('chk-'+id);if(!el)return;
  /* parse existing text into editable label + optional reservation */
  let raw=item.text.replace(/^⚠️\s*/,'');
  const prefixM=raw.match(/^(Hotel|Flight|Train|Book|Activity|Other|[^:]+):\s*/);
  if(prefixM)raw=raw.slice(prefixM[0].length);
  const dotM=raw.match(/^(.+?)\s+·\s+(.+)$/);
  const editLabel=dotM?dotM[1]:raw;
  const editResv=dotM?dotM[2]:'';
  el.innerHTML=
    '<input type="checkbox" '+(item.done?'checked':'')+' onchange="toggleCheckItem(\''+id+'\',this.checked)"/>'+
    '<div class="chk-inline-edit">'+
    '<input type="text" class="add-check-input" id="cedit-lbl-'+id+'" value="'+_escHtml(editLabel)+'" style="flex:1;min-width:100px;padding:6px 10px;font-size:12px" onkeydown="if(event.key===\'Enter\')saveEditCheckItem(\''+id+'\')"/>'+
    '<input type="text" class="add-check-input" id="cedit-resv-'+id+'" value="'+_escHtml(editResv)+'" placeholder="Conf #" style="width:110px;padding:6px 10px;font-size:12px" onkeydown="if(event.key===\'Enter\')saveEditCheckItem(\''+id+'\')"/>'+
    '<button class="add-check-btn" style="padding:6px 12px;font-size:12px" onclick="saveEditCheckItem(\''+id+'\')">&#10003;</button>'+
    '<button class="chk-edit-btn" style="font-size:16px;padding:0 6px" onclick="cancelEditCheckItem(\''+id+'\')" title="Cancel">&#10005;</button>'+
    '</div>';
  document.getElementById('cedit-lbl-'+id)?.focus();
}
function saveEditCheckItem(id){
  const item=(state.checklist||[]).find(i=>i.id===id);if(!item)return;
  const lbl=(document.getElementById('cedit-lbl-'+id)?.value||'').trim();
  const resv=(document.getElementById('cedit-resv-'+id)?.value||'').trim();
  if(!lbl)return;
  /* preserve WHATEVER prefix the item had (Hotel/Flight/Activity/Other/custom), not just a fixed set */
  const prefixM=item.text.replace(/^⚠️\s*/,'').match(/^([^:·]+):\s*/);
  const prefix=prefixM?prefixM[1].trim()+': ':'';
  item.text=prefix+lbl+(resv?' · '+resv:'');
  saveState();
  const el=document.getElementById('chk-'+id);if(el)el.outerHTML=_chkItemHtml(item);
}
function cancelEditCheckItem(id){
  const item=(state.checklist||[]).find(i=>i.id===id);if(!item)return;
  const el=document.getElementById('chk-'+id);if(el)el.outerHTML=_chkItemHtml(item);
}

/* ---- Packing list ---- */
const PACK_FALLBACK=[
  {emoji:'🧳',name:'Essentials',items:['Passport / ID','Travel insurance docs','Credit cards & cash','Phone & charger','Portable battery','Medications','First aid kit']},
  {emoji:'👕',name:'Clothing',items:['T-shirts (1 per day)','Pants / shorts','Underwear & socks','Comfortable walking shoes','Light jacket or layer','Sleepwear','Swimsuit','Rain jacket']},
  {emoji:'🧴',name:'Toiletries',items:['Toothbrush & toothpaste','Deodorant','Sunscreen','Face wash','Hair brush','Razor']},
  {emoji:'📱',name:'Tech & Comfort',items:['Camera','Universal adapter','Offline maps downloaded','Neck pillow & eye mask','Reusable water bottle','Snacks','Day bag']},
];

const PACK_PROMPT_SYSTEM='You are a minimalist travel packing expert who helps people pack light and smart. Philosophy: one carry-on max, wear items multiple times, choose versatile pieces. Generate a trip-specific packing list as JSON. Return ONLY the JSON object, no markdown, no backticks. Format: {"categories":[{"emoji":"🧳","name":"Category","items":["item 1","item 2"]}]}. Use 5-7 categories. Rules: (1) Keep each category to 5-8 items max — ruthlessly cut anything non-essential. (2) Always include a "Local Essentials" category with region-specific items: correct power adapter type, local SIM or data plan advice, any required travel documents or visas, local customs items, currency tips, anything a seasoned traveler to that specific region would flag. (3) Clothing: recommend exact counts (e.g. "3 versatile tops") based on trip length — assume re-wearing and laundry. No "pack 7 shirts for a week." (4) Flag items people typically over-pack and remind them to leave those out. Tailor everything to the destinations, activities, climate, and duration.';

function renderPackingListHtml(){
  const stored=lsPack();
  const categories=stored?stored.categories:null;
  if(!categories){
    return'<div class="pack-empty">'+
      '<p>Generate a personalized packing list tailored to this specific trip.</p>'+
      '<button class="pack-gen-btn" onclick="generatePackingList()">&#10024; Generate Packing List with AI</button>'+
      '</div>';
  }
  const checked=stored.checked||{};
  const total=categories.reduce((n,c)=>n+c.items.length,0);
  const checkedCount=Object.values(checked).filter(Boolean).length;
  return'<div class="pack-header-row">'+
    '<span class="pack-prog">'+checkedCount+' of '+total+' packed</span>'+
    '<button class="pack-gen-btn regen" style="width:auto;padding:6px 14px;font-size:12px" onclick="generatePackingList()">&#8635; Regenerate</button>'+
    '</div>'+
    categories.map((cat,ci)=>{
      const catChecked=cat.items.filter((_,ii)=>checked[ci+'-'+ii]).length;
      return'<div class="pack-section">'+
        '<div class="pack-section-hdr" onclick="togglePackSection('+ci+')" aria-expanded="true">'+
        '<span class="pack-name">'+_escHtml(cat.emoji)+' '+_escHtml(cat.name)+'</span>'+
        '<span class="pack-count">'+catChecked+'/'+cat.items.length+' <span class="pack-toggle" id="pack-tog-'+ci+'">&#9660;</span></span>'+
        '</div>'+
        '<div class="pack-items open" id="pack-cat-'+ci+'">'+
        cat.items.map((item,ii)=>{
          const key=ci+'-'+ii;
          const isChecked=!!checked[key];
          return'<label class="pack-item'+(isChecked?' checked':'')+'">'+
            '<input type="checkbox" '+(isChecked?'checked':'')+' onchange="togglePackItem(\''+key+'\',this.checked)"/>'+
            '<span class="pack-item-text">'+_escHtml(item)+'</span>'+
            '</label>';
        }).join('')+
        '</div></div>';
    }).join('');
}

function togglePackSection(ci){
  const items=document.getElementById('pack-cat-'+ci);
  const tog=document.getElementById('pack-tog-'+ci);
  if(!items)return;
  const open=items.classList.toggle('open');
  if(tog)tog.textContent=open?'▼':'▶';
}

function togglePackItem(key,checked){
  let stored=lsPack()||{categories:PACK_FALLBACK,checked:{}};
  if(!stored.checked)stored.checked={};
  stored.checked[key]=checked;
  lsPack(stored);
  /* update UI without full rerender */
  const label=document.querySelector('[onchange="togglePackItem(\''+key+'\',this.checked)"]')?.closest('.pack-item');
  if(label)label.classList.toggle('checked',checked);
  /* update progress */
  const total=stored.categories.reduce((n,c)=>n+c.items.length,0);
  const cnt=Object.values(stored.checked).filter(Boolean).length;
  const prog=document.querySelector('.pack-prog');
  if(prog)prog.textContent=cnt+' of '+total+' packed';
}

function loadFallbackPacking(){
  lsPack({categories:PACK_FALLBACK,checked:{}});
  switchDay(-1);
}

async function generatePackingList(){
  const btn=document.querySelector('.pack-gen-btn:not(.regen),.pack-gen-btn.regen');
  if(btn){btn.textContent='Generating…';btn.disabled=true;}
  try{
    let prompt='Trip: '+(state.title||'Unknown trip')+'\n';
    prompt+='Days: '+state.days.length+'\n';
    if(state._meta){
      if(state._meta.who)prompt+='Travelers: '+state._meta.who+'\n';
      if(state._meta.activities&&state._meta.activities.length)prompt+='Interests: '+state._meta.activities.join(', ')+'\n';
      if(state._meta.budgetLevel)prompt+='Budget: '+state._meta.budgetLevel+'\n';
    }
    const stopNames=state.days.flatMap(d=>d.stops.map(s=>s.name)).slice(0,12);
    if(stopNames.length)prompt+='Key stops: '+stopNames.join(', ')+'\n';
    const lodgeNames=state.days.flatMap(d=>d.stops.filter(s=>s.type==='lodge').map(s=>s.name));
    if(lodgeNames.length)prompt+='Accommodations: '+lodgeNames.join(', ')+'\n';
    const regions=[...new Set(state.days.flatMap(d=>d.stops.filter(s=>s.type==='lodge'||s.type==='hike'||s.type==='food').map(s=>s.name.split(/[—–,]/)[0].trim())))].slice(0,6);
    if(regions.length)prompt+='Regions/destinations: '+regions.join(', ')+'\n';
    const text=await callClaude(PACK_PROMPT_SYSTEM,prompt);
    let parsed;
    try{
      const t=text.trim().replace(/```(?:json)?/gi,'').replace(/```/g,'').trim();
      const js=t.indexOf('{'),je=t.lastIndexOf('}');
      parsed=JSON.parse(js!==-1&&je>js?t.slice(js,je+1):t);
    }catch(e){throw new Error('AI returned unexpected format for packing list');}
    if(!parsed.categories||!parsed.categories.length)throw new Error('No categories returned');
    lsPack({categories:parsed.categories,checked:{}});
    switchDay(-1);
  }catch(e){
    showToast('Packing list error: '+e.message,4000);
    if(btn){btn.textContent=btn.classList.contains('regen')?'↺ Regenerate':'✨ Generate Packing List with AI';btn.disabled=false;}
  }
}

async function callClaude(systemPrompt,userPrompt){
  const res=await fetch(PROXY_URL,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({system:systemPrompt,user:userPrompt.trim()})
  });
  if(!res.ok){const d=await res.json().catch(()=>({}));throw new Error('AI error: '+(d.error?.message||'HTTP '+res.status));}
  const data=await res.json();
  const text=data.content?.[0]?.text||'';
  if(!text)throw new Error('Empty response from AI');
  return text;
}

async function renderOverviewMap(fit=true){
  markersLayer.clearLayers();routeLayer.clearLayers();
  const bounds=[];
  state.days.forEach((day,di)=>{
    day.stops.forEach((s,si)=>{
      if(!s.lat||!s.lng)return;
      const m=L.marker([s.lat,s.lng],{icon:makeIcon(di+1,TC[s.type]||'#8B7355',s.alt)});
      m.bindPopup('<div style="font-weight:700;font-size:13px">Day '+(di+1)+': '+_escHtml(s.name)+'</div>',{maxWidth:200});
      markersLayer.addLayer(m);bounds.push([s.lat,s.lng]);
    });
  });
  if(fit&&bounds.length)map.fitBounds(bounds,{padding:[40,40]});
  document.getElementById('route-status').style.display='none';
}

/* ---- Excel export ---- */
function downloadExcel(){
  if(typeof XLSX==='undefined'){alert('Excel library not loaded yet. Please wait a moment and try again.');return;}
  if(!state||!state.days||!state.days.length){alert('No trip data to export.');return;}
  const typeLabel={hike:'Hike / Park',food:'Food',lodge:'Lodging',drive:'Drive',flight:'Flight',train:'Train',bus:'Bus'};
  /* ---- Itinerary sheet ---- */
  const rows=[['Day','Date / Theme','Stop #','Time','Place','Type','Stars','Confirmation #','Airline','Flight #','Notes']];
  state.days.forEach((day,di)=>{
    const theme=day.title.replace(/^Day \d+\s*[—–]\s*/,'');
    const sub=day.subtitle||(day.title)||'';
    const datePart=sub.split(/\s*[·•]\s*/)[0].trim();
    if(day.stops.length===0){
      rows.push(['Day '+(di+1),datePart||theme,'','','(no stops yet)','','','','','','']);
    } else {
      day.stops.forEach((s,si)=>{
        rows.push([
          'Day '+(di+1),
          datePart||theme,
          si+1,
          s.time||'',
          s.name||'',
          typeLabel[s.type]||s.type||'',
          s.stars?parseFloat(s.stars)||s.stars:'',
          s.reservation||'',
          s.airline||'',
          s.flightNumber||'',
          s.notes||''
        ]);
      });
    }
  });
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!cols']=[{wch:8},{wch:22},{wch:7},{wch:10},{wch:32},{wch:10},{wch:7},{wch:18},{wch:20},{wch:12},{wch:44}];
  /* bold the header row */
  const hdrRange=XLSX.utils.decode_range(ws['!ref']);
  for(let c=hdrRange.s.c;c<=hdrRange.e.c;c++){
    const cell=XLSX.utils.encode_cell({r:0,c});
    if(ws[cell])ws[cell].s={font:{bold:true}};
  }
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Itinerary');
  /* ---- Checklist sheet (if any items) ---- */
  if(state.checklist&&state.checklist.length){
    const chkRows=[['Item','Done']];
    state.checklist.forEach(c=>chkRows.push([c.text,c.done?'Yes':'']));
    const wsC=XLSX.utils.aoa_to_sheet(chkRows);
    wsC['!cols']=[{wch:44},{wch:6}];
    XLSX.utils.book_append_sheet(wb,wsC,'Checklist');
  }
  const filename=(state.title||'Itinerary').replace(/[\/\\?%*:|"<>]/g,'-')+'.xlsx';
  XLSX.writeFile(wb,filename);
}

/* ---- Family trip sync (Firebase REST, polling) ---- */
const BUILT_IN=['utah','ny-fall','london-scotland'];

function _sessionId(){
  let id=sessionStorage.getItem('_csid');
  if(!id){id=Math.random().toString(36).slice(2,8);sessionStorage.setItem('_csid',id);}
  return id;
}

function getTripType(){return (state&&state.tripType)||(BUILT_IN.includes(tripId)?'family':'solo');}

function _familyBase(){return FIREBASE_CONFIG.databaseURL+'/family/'+tripId;}

let _familySyncTimer=null,_familyPoll=null,_lastFamilyAt=0,_presenceTimer=null;

// WHOLE-NODE read. This now also contains /history (5 full itinerary copies), so
// it is ~6x the itinerary. NEVER call it in a hot path (the 3s poll or a save) —
// use _dbFamilyGet('/state') / '/lastChange' instead. Kept for the recovery screen.
async function _dbFamilyGetAll(){
  const r=await fetch(_familyBase()+'.json?nc='+Date.now(),{cache:'no-store'});
  if(!r.ok)throw new Error('Firebase '+r.status);
  return r.json();
}
// Read ONE subpath (e.g. '/state', '/lastChange'). Keeps the 3-second poll tiny.
async function _dbFamilyGet(subpath){
  const r=await fetch(_familyBase()+subpath+'.json?nc='+Date.now(),{cache:'no-store'});
  if(!r.ok)throw new Error('Firebase '+r.status);
  return r.json();
}
async function _dbFamilyPut(subpath,data){
  const r=await fetch(_familyBase()+subpath+'.json',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  if(!r.ok)console.warn('[family] PUT failed:',r.status);
}
async function _dbFamilyDelete(subpath){
  await fetch(_familyBase()+subpath+'.json',{method:'DELETE',keepalive:true}).catch(()=>{});
}

function _syncFamily(changeDesc){
  clearTimeout(_familySyncTimer);
  _familySyncTimer=setTimeout(async()=>{
    const next=JSON.parse(JSON.stringify(state));
    // Read what's currently in the cloud so we can (a) run the safety brake and
    // (b) snapshot it into the rolling 5-version history before overwriting.
    let cloud=null;
    try{ const st=await _dbFamilyGet('/state'); if(_validTripState(st))cloud=st; }catch(e){}
    if(cloud&&_wouldLoseData(cloud,next)){
      // Safety brake: this push would erase most of the shared itinerary. Never
      // silently overwrite it — keep the change local and say so out loud.
      try{console.warn('[family] push blocked — would lose data vs the shared copy');}catch(e){}
      try{showToast('⚠ NOT SYNCED — this change would erase most of the shared itinerary, so it was kept only on this device.');}catch(e){}
      return;
    }
    const ts=Date.now();_lastFamilyAt=ts;
    // Rolling cloud history: bank the copy we're about to replace, keep newest 5.
    if(cloud){ await _dbBackupBeforeOverwrite(cloud,ts,changeDesc); }
    await _dbFamilyPut('/state',next).catch(()=>{});
    await _dbFamilyPut('/lastChange',{at:ts,by:_sessionId(),desc:changeDesc||''}).catch(()=>{});
  },600);
}

function _startPresence(){
  _dbFamilyPut('/presence/'+_sessionId(),{at:Date.now()}).catch(()=>{});
  _presenceTimer=setInterval(()=>_dbFamilyPut('/presence/'+_sessionId(),{at:Date.now()}).catch(()=>{}),30000);
  window.addEventListener('beforeunload',_cleanupPresence);
}
function _stopPresence(){
  clearInterval(_presenceTimer);_presenceTimer=null;
  _dbFamilyDelete('/presence/'+_sessionId());
  window.removeEventListener('beforeunload',_cleanupPresence);
}
function _cleanupPresence(){
  _dbFamilyDelete('/presence/'+_sessionId());
}

function _watchFamily(){
  if(_familyPoll)clearInterval(_familyPoll);
  _familyPoll=setInterval(async()=>{
    try{
      // Poll ONLY the tiny lastChange marker. Fetching the whole node here pulled
      // /history (5 full itinerary copies) every 3 seconds — hundreds of MB an
      // hour — which throttled and broke syncing on phones.
      const lc=await _dbFamilyGet('/lastChange');
      if(!lc||!(lc.at>_lastFamilyAt)||lc.by===_sessionId())return;
      const incoming=await _dbFamilyGet('/state');   // fetched only when it changed
      // Validate the incoming cloud state before adopting it — a malformed or
      // empty push must never silently wipe/corrupt everyone's itinerary.
      if(!_validTripState(incoming)){ _lastFamilyAt=lc.at; return; }
      _lastFamilyAt=lc.at;
      state=incoming;
      // Adopt EXACTLY what the cloud holds. Re-sorting here mutated the adopted
      // copy without pushing it back, so devices silently drifted out of order.
      try{ _seedLogicBaseline(); }catch(e){}   // adopted cloud state is the new baseline
      try{localStorage.setItem(LS_KEY,JSON.stringify(state))}catch(e){}
      renderAll();
      showToast('✎ Change: '+_escHtml(lc.desc||'itinerary updated'));
    }catch(e){}
  },3000);
}

function _startFamily(){_watchFamily();_startPresence();}

// EXPLICIT, USER-TRIGGERED restore to the original saved plan. Fires ONLY when
// the app is opened with ?restore=savedplan AND the user taps OK on the confirm.
// Never runs automatically. It overwrites the shared cloud copy, so it is the
// deliberate "roll it all back to the committed plan" escape hatch. For
// london-scotland it applies the corrected Day 7 the user dictated (the seed
// file still lists the old Rosslyn stop). Returns true if a restore was pushed.
async function _restoreSavedPlan(){
  let plan;
  try{
    const r=await fetch('trips/'+tripId+'.json',{cache:'no-store'});
    plan=await r.json();
  }catch(e){ alert('Restore failed — could not load the saved plan: '+(e&&e.message||e)); return false; }
  if(!plan||!Array.isArray(plan.days)||!plan.days.length){ alert('Restore failed — the saved plan looks empty.'); return false; }
  // london-scotland: replace the seed's old Day 7 (Rosslyn) with the corrected
  // one the user dictated. _SCOTLAND_DAY7 is used ONLY here, on explicit request.
  if(tripId==='london-scotland' && typeof _SCOTLAND_DAY7!=='undefined'){
    const di=plan.days.findIndex(d=>/glenfinnan|glencoe|rosslyn/i.test((d.title||'')+' '+(d.stops||[]).map(s=>s.name||'').join(' ')));
    if(di>=0) plan.days[di].stops=JSON.parse(JSON.stringify(_SCOTLAND_DAY7));
  }
  const fam=getTripType()!=='solo';
  plan.tripType=fam?'family':'solo';
  const dayCount=plan.days.length;
  if(!confirm('Restore the original saved plan ('+dayCount+' days)?\n\n'+
      'This replaces the CURRENT itinerary'+(fam?' on every device sharing this trip':'')+
      ' with the committed plan. It cannot be undone, and it will overwrite any changes not already lost.\n\nTap OK only if the itinerary is currently wrong and you want the saved plan back.')){
    return false;
  }
  state=plan;
  try{localStorage.setItem(LS_KEY,JSON.stringify(state))}catch(e){}
  if(fam){
    const ts=Date.now();_lastFamilyAt=ts;
    try{
      await _dbFamilyPut('/state',JSON.parse(JSON.stringify(state)));
      await _dbFamilyPut('/lastChange',{at:ts,by:_sessionId(),desc:'Restored the saved plan'});
    }catch(e){ alert('Saved locally, but pushing to the shared cloud failed: '+(e&&e.message||e)); }
  }
  // Reload clean, without the restore param, so it can never re-fire.
  location.href=location.pathname+'?id='+encodeURIComponent(tripId)+(fam?'&fam=1':'');
  return true;
}
function _stopFamily(){
  if(_familyPoll){clearInterval(_familyPoll);_familyPoll=null;}
  _stopPresence();
}

// ===========================================================================
// RECOVERY SCREEN (?recover=1). A self-contained rescue UI that NEVER touches
// the cloud on its own. It short-circuits init() BEFORE any cloud fetch or the
// family watcher starts, so opening it can never overwrite this device's saved
// copy. Section 1 shows/exports this device's saved itinerary (localStorage);
// Section 2 pastes a good copy and pushes it to every device. This is how a
// device that still holds the real itinerary rescues everyone.
// ===========================================================================
// Build a human-readable preview (day titles + every stop name) and a keyword
// check from a raw JSON string. Lets the user CONFIRM a copy is the right one
// (e.g. it contains "Lincoln") before trusting or pushing it.
function _recPreview(raw,keyword){
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let st;
  try{ st=JSON.parse(raw); }catch(e){ return {ok:false,html:'<span style="color:#a00">Not valid JSON.</span>',days:0,stops:0,has:false}; }
  if(!st||!Array.isArray(st.days)){ return {ok:false,html:'<span style="color:#a00">No itinerary days found in this copy.</span>',days:0,stops:0,has:false}; }
  const kw=(keyword||'').trim().toLowerCase();
  const has=kw?raw.toLowerCase().indexOf(kw)>=0:false;
  let stops=0, rows='';
  st.days.forEach((d,i)=>{
    const names=(d.stops||[]).map(s=>s.name||'').filter(Boolean);
    stops+=names.length;
    const hl=names.map(n=>{
      const hit=kw&&n.toLowerCase().indexOf(kw)>=0;
      return hit?'<b style="background:#fde68a">'+esc(n)+'</b>':esc(n);
    }).join(', ');
    rows+='<div style="padding:4px 0;border-top:1px solid #eee;font-size:12px"><b>Day '+(i+1)+'</b> '+esc(d.title||'')+'<br><span style="color:#555">'+(hl||'<i>no stops</i>')+'</span></div>';
  });
  return {ok:true,days:st.days.length,stops:stops,has:has,html:rows};
}
// Gather EVERY copy of the itinerary stored on this device, from all storage
// layers — because the live copy and the offline-download copy are DIFFERENT
// and the sync/reset only overwrites the live one. An offline copy saved while
// the trip was still good can survive a corruption of the live copy.
async function _recGather(){
  const out=[];
  const seen={};
  const add=(label,raw)=>{ if(!raw||seen[raw])return; seen[raw]=1; out.push({label:label,raw:raw}); };
  try{ add('Live copy on this device', localStorage.getItem(LS_KEY)); }catch(e){}
  if('caches' in window){
    // The offline-download copy — untouched by the 3-second sync and the reset.
    try{ const r=await caches.match('/Travel/offline-state/'+encodeURIComponent(tripId)+'.json'); if(r){ add('Offline-download copy on this device', await r.text()); } }catch(e){}
    // Also sweep every cache entry that looks like a saved state for this trip.
    try{
      const keys=await caches.keys();
      for(const ck of keys){
        const c=await caches.open(ck);
        const reqs=await c.keys();
        for(const rq of reqs){
          if(/offline-state/.test(rq.url)&&rq.url.indexOf(encodeURIComponent(tripId))>=0){
            try{ const rr=await c.match(rq); if(rr){ add('Cache '+ck, await rr.text()); } }catch(e){}
          }
        }
      }
    }catch(e){}
  }
  // The automatic CLOUD backups — the rolling 5 versions saved before each
  // overwrite. Newest first, each timestamped. Available from any device.
  try{
    const r=await fetch(_familyBase()+'/history.json?nc='+Date.now(),{cache:'no-store'});
    const hist=await r.json();
    if(hist&&typeof hist==='object'){
      Object.keys(hist).sort((a,b)=>Number(b)-Number(a)).forEach(k=>{
        const h=hist[k];
        if(h&&h.state&&Array.isArray(h.state.days)){
          let when=''; try{ when=new Date(h.at||Number(k)).toLocaleString(); }catch(e){}
          add('Weekly cloud backup'+(when?' — '+when:''), JSON.stringify(h.state));
        }
      });
    }
  }catch(e){}
  // Sweep every localStorage key for anything that parses as an itinerary.
  try{
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(!k||k===LS_KEY)continue;
      const v=localStorage.getItem(k);
      if(v&&v.length>200&&v.indexOf('"days"')>=0){
        try{ const o=JSON.parse(v); if(o&&Array.isArray(o.days)&&o.days.length){ add('Saved data under key “'+k+'”', v); } }catch(e){}
      }
    }
  }catch(e){}
  return out;
}
async function _recoveryScreen(){
  document.title='Seasons — Recovery';
  const kw='Lincoln';
  const sources=await _recGather();
  window._recSources=sources;
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const box='border:1px solid #ddd;border-radius:10px;padding:14px;margin:14px 0;background:#fff';
  const btn='padding:11px 15px;border:0;border-radius:8px;color:#fff;font-size:14px;cursor:pointer';
  // Render one card per copy found, best (contains keyword) first.
  const cards=sources.map((s,i)=>({s,i,pv:_recPreview(s.raw,kw)}))
    .sort((a,b)=>(b.pv.has?1:0)-(a.pv.has?1:0))
    .map(({s,i,pv})=>{
      const banner=pv.ok?
        (pv.has?'<div style="padding:8px 10px;border-radius:8px;margin:0 0 8px;font-weight:700;background:#dcfce7;color:#166534">✓ CONTAINS “'+esc(kw)+'” — '+pv.days+' days · '+pv.stops+' stops. This looks like the RIGHT copy.</div>'
                :'<div style="padding:8px 10px;border-radius:8px;margin:0 0 8px;font-weight:700;background:#fee2e2;color:#991b1b">✗ Does NOT contain “'+esc(kw)+'” ('+pv.days+' days · '+pv.stops+' stops).</div>')
        :'<div style="padding:8px 10px;border-radius:8px;margin:0 0 8px;background:#fef9c3;color:#713f12">Could not read this copy as an itinerary.</div>';
      return '<div style="'+box+'">'+
        '<h3 style="margin:0 0 6px">'+esc(s.label)+'</h3>'+
        banner+
        (pv.ok?'<details style="margin:6px 0"><summary style="cursor:pointer;font-size:13px;color:#2563eb">Show every day &amp; stop</summary>'+
          '<div style="margin-top:6px;max-height:300px;overflow:auto">'+pv.html+'</div></details>'+
          '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">'+
            '<button onclick="_recPush('+i+')" style="'+btn+';background:#dc2626">Push THIS copy to all devices</button>'+
            '<button onclick="_recCopy('+i+')" style="'+btn+';background:#2563eb">Copy</button>'+
            '<button onclick="_recDownload('+i+')" style="'+btn+';background:#059669">Download</button>'+
          '</div>':'')+
      '</div>';
    }).join('');
  document.body.innerHTML=
    '<div style="max-width:680px;margin:0 auto;padding:16px;font-family:system-ui,-apple-system,sans-serif;color:#111;background:#f6f7f9;min-height:100vh">'+
      '<h2 style="margin:8px 0">Itinerary recovery</h2>'+
      '<p style="color:#555;font-size:14px;margin:0 0 4px">Trip: <b>'+esc(tripId)+'</b>. Nothing changes until you tap a button. Checking for a copy that contains “'+esc(kw)+'”.</p>'+
      '<p style="color:#555;font-size:13px;margin:2px 0 0">Found <b>'+sources.length+'</b> stored '+(sources.length===1?'copy':'copies')+' on this device.</p>'+
      (cards||'<div style="'+box+'"><p style="color:#a00;margin:0">No stored itinerary copies were found on this device.</p></div>')+
      '<div style="'+box+'">'+
        '<h3 style="margin:0 0 6px">Restore from a backup file or paste</h3>'+
        '<p style="color:#555;font-size:13px;margin:0 0 8px">Load a downloaded backup file, or paste a copy, then push it to every device.</p>'+
        '<div style="margin:0 0 8px"><input type="file" id="rec-file" accept=".json,application/json" onchange="_recLoadFile(event)"></div>'+
        '<textarea id="rec-in" placeholder="…or paste itinerary JSON here" style="width:100%;height:110px;font-family:monospace;font-size:11px;border:1px solid #ccc;border-radius:6px;padding:8px;box-sizing:border-box"></textarea>'+
        '<div id="rec-in-badge" style="font-size:13px;margin:8px 0;font-weight:600"></div>'+
        '<div><button onclick="_recImport()" style="'+btn+';background:#dc2626">Restore this copy to all devices</button></div>'+
        '<p id="rec-msg" style="font-size:13px;margin-top:8px;font-weight:600"></p>'+
      '</div>'+
      '<p style="color:#888;font-size:12px">Version '+(window.APP_CODE_VERSION||'')+'</p>'+
    '</div>';
}
function _recSrcRaw(i){ const s=(window._recSources||[])[i]; return s?s.raw:''; }
// Push a specific stored copy straight to all devices.
function _recPush(i){ _recPushRaw(_recSrcRaw(i)); }
function _recCopy(i){
  const v=_recSrcRaw(i); if(!v)return;
  const done=()=>alert('Copied. Paste it somewhere safe now — emailing it to yourself is ideal.');
  try{ navigator.clipboard.writeText(v).then(done,done); }catch(e){ done(); }
}
function _recDownload(i){
  const v=_recSrcRaw(i); if(!v)return;
  try{
    const blob=new Blob([v],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download=tripId+'-backup.json'; document.body.appendChild(a); a.click(); a.remove();
  }catch(e){ alert('Download failed: '+(e&&e.message||e)); }
}
// Load a downloaded backup .json file into the paste box and show a check.
function _recLoadFile(ev){
  const f=ev&&ev.target&&ev.target.files&&ev.target.files[0]; if(!f)return;
  const rd=new FileReader();
  rd.onload=()=>{
    const ta=document.getElementById('rec-in'); if(ta)ta.value=String(rd.result||'');
    const pv=_recPreview(String(rd.result||''),'Lincoln');
    const b=document.getElementById('rec-in-badge');
    if(b)b.innerHTML=pv.ok?((pv.has?'<span style="color:#166534">✓ Loaded — contains “Lincoln”':'<span style="color:#991b1b">⚠ Loaded — does NOT contain “Lincoln”')+'</span> ('+pv.days+' days · '+pv.stops+' stops).'):'<span style="color:#991b1b">That file is not a valid itinerary.</span>';
  };
  rd.onerror=()=>{ const b=document.getElementById('rec-in-badge'); if(b)b.textContent='Could not read that file.'; };
  rd.readAsText(f);
}
// Validate a raw JSON copy, confirm, then write it to this device AND push it to
// the shared cloud so every device syncs it. Used by both the per-copy buttons
// and the paste/file box.
async function _recPushRaw(raw){
  const msg=document.getElementById('rec-msg');
  const setMsg=(s,c)=>{ if(msg){ msg.textContent=s; msg.style.color=c||'#111'; } };
  let st;
  try{ st=JSON.parse((raw||'').trim()); }
  catch(e){ alert('That copy is not valid JSON.'); return; }
  if(!st||!Array.isArray(st.days)||!st.days.length){ alert('That copy has no days in it — refusing to restore an empty itinerary.'); return; }
  const days=st.days.length, stops=st.days.reduce((n,d)=>n+((d.stops||[]).length),0);
  const hasKw=(raw||'').toLowerCase().indexOf('lincoln')>=0;
  if(!confirm('Restore this copy — '+days+' days, '+stops+' stops'+(hasKw?' (contains “Lincoln”)':' — does NOT contain “Lincoln”')+' — to EVERY device sharing this trip?\n\nThis overwrites the current shared itinerary. Do this only if this is the correct copy.')) return;
  if(!st.tripType) st.tripType='family';
  try{ localStorage.setItem(LS_KEY,JSON.stringify(st)); }catch(e){}
  try{
    const ts=Date.now(); _lastFamilyAt=ts;
    // Bank the copy we're about to overwrite into the rolling 5-version history.
    try{ const all=await _dbFamilyGetAll(); if(all&&_validTripState(all.state))await _dbBackupBeforeOverwrite(all.state,ts,'Before restore'); }catch(e){}
    await _dbFamilyPut('/state',JSON.parse(JSON.stringify(st)));
    await _dbFamilyPut('/lastChange',{at:ts,by:_sessionId(),desc:'Restored from a saved copy'});
    setMsg('Restored ('+days+' days, '+stops+' stops) and pushed to the cloud. Other devices update within a few seconds. Reloading…','#059669');
    alert('Restored '+days+' days, '+stops+' stops and pushed to the cloud. Reloading…');
    setTimeout(()=>{ location.href=location.pathname+'?id='+encodeURIComponent(tripId)+'&fam=1'; },1400);
  }catch(e){ alert('Saved on THIS device, but pushing to the cloud failed: '+((e&&e.message)||e)+'. Try again.'); }
}
function _recImport(){ const t=document.getElementById('rec-in'); return _recPushRaw((t&&t.value)||''); }

function _updateTypeBadge(){
  const el=document.getElementById('trip-type-badge');
  if(!el)return;
  const t=getTripType();
  el.innerHTML=t==='family'?'&#127968; Shared':'&#128100; Not Sharing';
  el.style.color=t==='family'?'var(--river)':'var(--amber)';
  el.style.background=t==='family'?'var(--river-tint)':'var(--amber-tint)';
  el.style.borderColor=t==='family'?'var(--river-border)':'rgba(196,123,32,0.22)';
}

function toggleTripType(){
  const current=getTripType();
  const next=current==='family'?'solo':'family';
  const msg=next==='family'
    ?'Start sharing this trip? It will sync to the cloud and be visible to everyone in the family.'
    :'Stop sharing this trip? It will only be saved on this device.';
  if(!confirm(msg))return;
  state.tripType=next;
  if(next==='family'){
    localStorage.setItem('tripFamily_'+tripId,'1');
    _dbFamilyPut('/state',JSON.parse(JSON.stringify(state))).catch(()=>{});
    _dbFamilyPut('/lastChange',{at:Date.now(),by:_sessionId(),desc:'Started sharing'}).catch(()=>{});
    _startFamily();
    showToast('&#127968; Now Shared — changes sync to cloud');
  }else{
    localStorage.removeItem('tripFamily_'+tripId);
    _stopFamily();
    showToast('&#128100; Not Sharing — saved on this device only');
  }
  try{localStorage.setItem(LS_KEY,JSON.stringify(state))}catch(e){}
  _updateTypeBadge();
}

function showToast(msg,duration=3000){
  const t=document.getElementById('share-toast');
  t.innerHTML=msg;t.classList.add('visible');
  setTimeout(()=>t.classList.remove('visible'),duration);
}

function reloadOriginal(){
  localStorage.removeItem(LS_KEY);
  location.reload();
}

function renameTripPrompt(){
  const cur = state.title || '';
  const next = prompt('Trip name:', cur);
  if(next === null) return;
  const name = next.trim();
  if(!name || name === cur) return;
  state.title = name;
  document.title = 'Seasons — ' + name;
  // Update the local trips manifest entry if this is a local trip
  try{
    const local = JSON.parse(localStorage.getItem('localTrips') || '[]');
    const entry = local.find(t => t.id === tripId);
    if(entry){ entry.title = name; localStorage.setItem('localTrips', JSON.stringify(local)); }
  }catch(e){}
  saveState('Renamed trip');
  renderAll();
}

function deleteTripFromView(){
  const title = state.title || 'this trip';
  if(!confirm('Delete "' + title + '"? This cannot be undone.')) return;
  // Remove from localStorage
  localStorage.removeItem(LS_KEY);
  // Remove from local trips list if present
  try{
    const local = JSON.parse(localStorage.getItem('localTrips') || '[]');
    localStorage.setItem('localTrips', JSON.stringify(local.filter(t => t.id !== tripId)));
  }catch(e){}
  // Add to hidden list for built-in / shared trips so they don't reappear
  if(BUILT_IN.includes(tripId) || getTripType() !== 'solo'){
    try{
      const hidden = JSON.parse(localStorage.getItem('hiddenTrips') || '[]');
      if(!hidden.includes(tripId)){ hidden.push(tripId); localStorage.setItem('hiddenTrips', JSON.stringify(hidden)); }
    }catch(e){}
  }
  // Stop cloud sync before leaving
  try{ _stopFamily(); }catch(e){}
  window.location.href = 'index.html';
}

/* ===== FEATURE EXTENSIONS ===== */

/* --- Read-Only Mode --- */
const IS_READONLY=new URLSearchParams(location.search).get('view')==='readonly';

/* --- Transit Mode --- */
let _pendingTransitMode=null;
function setTransitMode(mode){
  _pendingTransitMode=mode;
  document.querySelectorAll('.transit-mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
}
// End Time and Duration are INTERACTIVE: editing one recomputes the other, using
// Start Time as the anchor.
function _fVal(id){
  const e=document.getElementById(id);if(!e)return '';
  const v=(e.value||'').trim();
  // Native time inputs report 24h "20:30"; the helpers reason in canonical text.
  return (e.type==='time')?(_fromTimeInput(v)||v):v;
}
// If the end time is earlier on the clock than the start, this stop runs past
// midnight — roll the End Date to the next day automatically, the way a calendar
// does, instead of making the user discover an "end before start" error.
function _fAutoEndDate(){
  const s=_parseTimeMins(_fVal('f-time')),en=_parseTimeMins(_fVal('f-endtime'));
  const sd=_fVal('f-date'),ed=document.getElementById('f-enddate');
  if(!ed||s==null||en==null||!sd)return;
  try{
    const d0=new Date(sd+'T00:00:00');
    if(en<=s)d0.setDate(d0.getDate()+1);          // wrapped past midnight
    const want=_localISO(d0);
    // Only fill/repair it; never fight a date the user deliberately set further out.
    if(!ed.value||ed.value<sd||(en<=s&&ed.value===sd)||(en>s&&ed.value>sd&&!ed.dataset.userSet))ed.value=want;
  }catch(e){}
}
function _fSyncDurFromTimes(){ // Start/End changed → Duration = End − Start
  _fAutoEndDate();
  const s=_parseTimeMins(_fVal('f-time')),en=_parseTimeMins(_fVal('f-endtime')),d=document.getElementById('f-duration');
  if(!d||s==null||en==null)return;
  // An end at/before the start means the stop runs past midnight — show the real
  // elapsed time instead of leaving a stale duration from a previous stop.
  const span=(en>s)?(en-s):(1440-s+en);
  if(span>0&&span<=1440)d.value=_fmtDur(span);
}
function _fSyncEndFromDur(){ // Duration changed → End = Start + Duration
  const s=_parseTimeMins(_fVal('f-time')),dur=_durationToMins(_fVal('f-duration')),e=document.getElementById('f-endtime');
  if(e&&s!=null&&dur!=null&&dur>0){const t=_formatTimeMins((s+dur)%1440);e.value=(e.type==='time')?_toTimeInput(t):t;}
}
function _fSyncFromStart(){ // Start changed → keep the Duration if present (move End), else recompute Duration
  const dur=_durationToMins(_fVal('f-duration'));
  if(dur!=null&&dur>0)_fSyncEndFromDur(); else _fSyncDurFromTimes();
}
// Wire End Time <-> Duration on EVERY event that can change a field. `oninput`
// alone missed changes made by autofill, dictation, paste and some mobile
// keyboards, which left the two fields disagreeing on screen.
function _wireDurationSync(){
  const bind=(id,fn)=>{
    const el=document.getElementById(id);
    if(!el||el._durWired)return;
    el._durWired=1;
    ['input','change','blur','keyup','paste'].forEach(ev=>el.addEventListener(ev,()=>setTimeout(fn,0)));
  };
  const ed=document.getElementById('f-enddate');
  if(ed&&!ed._durWired){ed._durWired=1;ed.addEventListener('change',()=>{ed.dataset.userSet='1';});}
  bind('f-time',_fSyncFromStart);
  bind('f-endtime',_fSyncDurFromTimes);
  bind('f-duration',_fSyncEndFromDur);
}
function _defaultTransitMode(a,b){
  if(!a||!b)return'drive';
  if(a.type==='flight'||b.type==='flight')return'flight';
  if(a.type==='train'||b.type==='train')return'train';
  if(a.type==='bus'||b.type==='bus')return'bus';
  if(!a.lat||!a.lng||!b.lat||!b.lng)return'drive';
  return haversine(a.lat,a.lng,b.lat,b.lng)<1?'walk':'drive';
}
const TM_ICON={walk:'🚶',bike:'🚴',drive:'🚗',train:'🚆',bus:'🚌',flight:'✈️'};
const TM_LABEL={walk:'Walk',bike:'Bike',drive:'Drive',train:'Train',bus:'Bus',flight:'Flight'};
const TM_CLS={walk:'leg-mode-walk',bike:'leg-mode-bike',drive:'leg-mode-drive',train:'leg-mode-train',bus:'leg-mode-bus',flight:'leg-mode-flight'};

/* --- Journal Mode --- */
const JNL_LS='seasons_jnl_'+tripId;
let jnlData={};
try{jnlData=JSON.parse(localStorage.getItem(JNL_LS)||'{}')}catch(e){}
function _saveJnl(){try{localStorage.setItem(JNL_LS,JSON.stringify(jnlData))}catch(e){}}
// Stable per-stop / per-day ids so journal notes & ratings stay attached to their
// stop even after reordering or deleting stops/days (they used to be keyed by
// position, which mis-associated everything on any change).
function _ensureJnlIds(){
  if(!state||!state.days)return false;
  let ch=false;
  state.days.forEach(day=>{
    if(!day._did){day._did='d'+Math.random().toString(36).slice(2,10);ch=true;}
    (day.stops||[]).forEach(s=>{ if(!s._sid){s._sid='s'+Math.random().toString(36).slice(2,10);ch=true;} });
  });
  return ch;
}
function _jnlNoteKey(di,si){const s=state.days[di]&&state.days[di].stops[si];return 'n_'+((s&&s._sid)||(di+'_'+si));}
function _jnlRatingKey(di,si){const s=state.days[di]&&state.days[di].stops[si];return 'r_'+((s&&s._sid)||(di+'_'+si));}
function _jnlDayKey(di){const d=state.days[di];return 'd_'+((d&&d._did)||di);}
// One-time: move existing position-keyed journal data onto the new stable ids.
function _migrateJnlKeys(){
  if(!state||!state.days)return;
  try{ if(localStorage.getItem('jnl_mig_'+tripId)==='1')return; }catch(e){}
  state.days.forEach((day,di)=>{
    const od=jnlData['d_'+di]; if(od!=null){const k=_jnlDayKey(di);if(jnlData[k]==null)jnlData[k]=od;}
    (day.stops||[]).forEach((s,si)=>{
      const on=jnlData['n_'+di+'_'+si]; if(on!=null){const k=_jnlNoteKey(di,si);if(jnlData[k]==null)jnlData[k]=on;}
      const orr=jnlData['r_'+di+'_'+si]; if(orr!=null){const k=_jnlRatingKey(di,si);if(jnlData[k]==null)jnlData[k]=orr;}
    });
  });
  _saveJnl();
  try{localStorage.setItem('jnl_mig_'+tripId,'1');}catch(e){}
}
function isJournalMode(){
  if(!state||!state.days.length)return false;
  const last=state.days[state.days.length-1];
  const dp=(last.subtitle||'').split(/\s*[·•]\s*/)[0].trim();
  if(!dp)return false;
  const d=_parseTripDate(dp);
  if(!d)return false;
  const today=new Date();today.setHours(0,0,0,0);
  d.setHours(0,0,0,0);
  return d<today;
}
function saveJnlStopNote(di,si,v){jnlData[_jnlNoteKey(di,si)]=v;_saveJnl();}
function saveJnlStopRating(di,si,r){
  jnlData[_jnlRatingKey(di,si)]=r;_saveJnl();
  for(let k=1;k<=5;k++){const el=document.getElementById('js_'+di+'_'+si+'_'+k);if(el)el.classList.toggle('lit',k<=r);}
}
function saveJnlDayEntry(di,v){jnlData[_jnlDayKey(di)]=v;_saveJnl();}
function _jnlStarsHtml(di,si,rat){
  return[1,2,3,4,5].map(k=>'<span class="jstar'+(k<=rat?' lit':'')+'" id="js_'+di+'_'+si+'_'+k+'" onclick="saveJnlStopRating('+di+','+si+','+k+')">&#9733;</span>').join('');
}
function _jnlStopHtml(di,si){
  const note=jnlData[_jnlNoteKey(di,si)]||'';
  const rat=jnlData[_jnlRatingKey(di,si)]||0;
  if(!note&&!rat)return'<div class="journal-section"><button class="jnl-add-btn" onclick="expandJnl(this,'+di+','+si+')">&#9997; Add memory</button></div>';
  return'<div class="journal-section">'+
    '<div class="journal-sec-label">&#9997; Journal</div>'+
    '<textarea class="journal-textarea" placeholder="How was it? Any memories..." oninput="saveJnlStopNote('+di+','+si+',this.value)">'+_escHtml(note)+'</textarea>'+
    '<div class="journal-stars">'+_jnlStarsHtml(di,si,rat)+'<span style="font-family:var(--font-ui);font-size:10px;color:var(--muted);margin-left:7px">Worth it?</span></div>'+
    '</div>';
}
function _jnlDayHtml(di){
  const entry=jnlData[_jnlDayKey(di)]||'';
  if(!entry)return'';
  return'<div class="day-journal-wrap">'+
    '<div class="day-journal-lbl">&#9997; Day '+(di+1)+' Memories</div>'+
    '<textarea class="journal-textarea" style="min-height:85px" placeholder="Overall day memories..." oninput="saveJnlDayEntry('+di+',this.value)">'+_escHtml(entry)+'</textarea>'+
    '</div>';
}
function expandJnl(btn,di,si){
  const note=jnlData[_jnlNoteKey(di,si)]||'';
  const rat=jnlData[_jnlRatingKey(di,si)]||0;
  const sec=btn.closest('.journal-section');
  sec.innerHTML='<div class="journal-sec-label">&#9997; Journal</div>'+
    '<textarea class="journal-textarea" placeholder="How was it? Any memories..." oninput="saveJnlStopNote('+di+','+si+',this.value)">'+_escHtml(note)+'</textarea>'+
    '<div class="journal-stars">'+_jnlStarsHtml(di,si,rat)+'<span style="font-family:var(--font-ui);font-size:10px;color:var(--muted);margin-left:7px">Worth it?</span></div>';
  sec.querySelector('textarea').focus();
}
function _tripHighlightsHtml(){
  const rated=[];
  state.days.forEach((d,di)=>d.stops.forEach((s,si)=>{
    const r=jnlData[_jnlRatingKey(di,si)]||0;
    if(r>=4)rated.push({name:s.name,r,di});
  }));
  if(!rated.length)return'';
  rated.sort((a,b)=>b.r-a.r);
  const rows=rated.slice(0,5).map(h=>
    '<div class="trip-highlights-item">'+
    '<span style="color:var(--amber);font-size:15px;white-space:nowrap">'+'&#9733;'.repeat(h.r)+'&#9734;'.repeat(5-h.r)+'</span>'+
    '<span style="font-family:var(--font-ui);font-size:13px;color:var(--ink);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_escHtml(h.name)+'</span>'+
    '<span style="font-family:var(--font-ui);font-size:11px;color:var(--muted);flex-shrink:0">Day '+(h.di+1)+'</span>'+
    '</div>'
  ).join('');
  return'<div class="ov-section"><div class="ov-heading">&#11088; Trip Highlights</div>'+rows+'</div>';
}

/* --- Passive Conflict Detection --- */
function _parseTimeMins(str){
  if(!str)return null;
  // ANCHORED: the whole string must be a clock time. This rejects duration
  // strings like "1h 30min" and ranges like "2-3pm" that previously parsed to
  // 1:00/2:00 AM and dragged the whole day's recalculated timeline to 1 AM.
  const m=String(str).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if(!m)return null;
  let h=parseInt(m[1]),mn=parseInt(m[2]||0),ap=(m[3]||'').toLowerCase();
  if(h>23||mn>59)return null;
  if(ap==='pm'&&h!==12)h+=12;
  if(ap==='am'&&h===12)h=0;
  return h*60+mn;
}
function _dayOfWeek(dayIdx){
  const day=state.days[dayIdx];if(!day)return-1;
  const dp=(day.subtitle||'').split(/\s*[·•]\s*/)[0].trim();
  if(!dp)return-1;
  const d=_parseTripDate(dp)||new Date(dp+' 12:00'); // infer correct year for weekday
  return isNaN(d)?-1:d.getDay();
}
function detectConflicts(dayIdx){
  const stops=state.days[dayIdx]?.stops||[];
  const out={};
  const dow=_dayOfWeek(dayIdx);
  for(let i=0;i<stops.length;i++){
    const s=stops[i],msgs=[];
    const ti=_parseTimeMins(s.time);
    if(i>0&&s.time&&stops[i-1].time){
      const tp=_parseTimeMins(stops[i-1].time);
      if(ti!==null&&tp!==null&&ti>0&&tp>0){
        if(ti===tp)msgs.push('Same time as stop '+i);
        else if(ti>tp&&ti-tp<15)msgs.push('Only '+(ti-tp)+' min after stop '+i);
      }
    }
    // TRAVEL FEASIBILITY: you can't arrive before you could physically get here —
    // previous stop's departure (its end, or start+visit) plus the travel time.
    if(i>0&&ti!==null){
      const prev=stops[i-1];
      const ps=_parseTimeMins(prev.time),pe=_parseTimeMins(prev.endTime);
      if(ps!==null){
        const dep=(pe!==null&&pe>ps)?pe:ps+_stopVisitMins(prev);
        const travel=_legTravelMins(prev,s);
        const earliest=dep+travel;
        if(travel>=15&&travel<=600&&ti<earliest-10){
          msgs.push('Impossible timing — the '+_minsToStr(travel)+' trip from the previous stop means the earliest you can arrive is '+_formatTimeMins(earliest)+', not '+_formatTimeMins(ti));
        }
      }
    }
    if(s.openingHours&&dow>=0){
      const arr=Array.isArray(s.openingHours)?s.openingHours:Object.values(s.openingHours);
      const todayText=arr[(dow+6)%7]||''; // Google weekday_text is Monday-indexed; dow is Sunday-indexed
      if(/closed/i.test(todayText)){msgs.push('Typically closed today');}
      else if(todayText&&ti!==null){
        const hm=todayText.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–]\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
        if(hm){
          const open=_parseTimeMins(hm[1]),close=_parseTimeMins(hm[2]);
          if(open!==null&&ti<open)msgs.push('Before opening ('+hm[1].trim()+')');
          else if(close!==null&&ti>close-45)msgs.push('Near closing — may miss last entry');
        }
      }
    }
    if(msgs.length)out[i]=msgs;
  }
  return out;
}

/* --- Weather Cache for Inline Warnings --- */
let _wxDayCache={};
function _wxWarnHtml(wx){
  if(!wx||wx.tooFarOut)return'';
  const rainy=[55,61,63,65,80,81,82,95,96,99];
  const isRain=rainy.includes(wx.code)||(wx.precip>=40);
  const isHot=wx.hi>=95,isCold=wx.lo<=20;
  if(!isRain&&!isHot&&!isCold)return'';
  const w=[];
  if(isRain)w.push('&#127783; Rain');
  if(isHot)w.push('&#127777; '+wx.hi+'&#176;F');
  if(isCold)w.push('&#10052; '+wx.lo+'&#176;F');
  return'<span class="wx-warn">'+w.join(' &middot; ')+'</span>';
}

/* --- Opening Hours / Place Meta --- */
async function lookupPlaceDetails(stop){
  // NOTE: these Google Places REST endpoints send no CORS headers, so a direct
  // browser fetch always throws and this feature is effectively inert. To actually
  // work it must be proxied through the travel-ai-proxy worker. Kept behind the
  // existing try/catch so nothing regresses.
  const key=_gpKey();
  if(!key||!stop.lat||!stop.lng||!stop.name)return;
  const ck='places_'+tripId+'_'+stop.name.slice(0,20);
  try{
    const r=await fetch('https://maps.googleapis.com/maps/api/place/textsearch/json?query='+
      encodeURIComponent(stop.name)+'&location='+stop.lat+','+stop.lng+'&radius=500&key='+key);
    if(!r.ok)return;
    const d=await r.json();
    const pid=d.results?.[0]?.place_id;if(!pid)return;
    const dr=await fetch('https://maps.googleapis.com/maps/api/place/details/json?place_id='+pid+
      '&fields=opening_hours,website,formatted_phone_number&key='+key);
    if(!dr.ok)return;
    const dd=await dr.json();
    const res=dd.result;if(!res)return;
    if(res.opening_hours?.weekday_text)stop.openingHours=res.opening_hours.weekday_text;
    if(res.website)stop.website=res.website;
    if(res.formatted_phone_number)stop.phone=res.formatted_phone_number;
    saveState('Updated place details: '+stop.name,true); // derived data — local only, don't clobber others' edits
    renderAll();
  }catch(e){}
}
// Opening hours for the specific day of the itinerary, shown in the stop's
// description area. Populated by addDayOpeningHours() (AI-estimated).
// ---- Real opening hours from OpenStreetMap (free, no API key) ----
const _DOW_NAMES=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const _OSM_DAY={su:0,mo:1,tu:2,we:3,th:4,fr:5,sa:6};
function _normPlaceName(n){
  return String(n||'').toLowerCase()
    .replace(/^(dinner|lunch|breakfast|brunch|coffee|drinks)\s*[—–-]\s*/,'')
    .replace(/[^a-z0-9 ]/g,' ').replace(/\b(the|a|an|of|at|de|la|le|and)\b/g,' ')
    .replace(/\s+/g,' ').trim();
}
function _to12h(hhmm){
  const m=String(hhmm).match(/^(\d{1,2}):(\d{2})$/);if(!m)return null;
  let h=+m[1];const mn=+m[2];if(h>24||mn>59)return null;
  const ap=(h<12||h===24)?'AM':'PM';let h12=h%12;if(h12===0)h12=12;
  return h12+':'+(mn<10?'0':'')+mn+' '+ap;
}
// Parse an OSM opening_hours string for one weekday. Conservative: returns null
// on anything seasonal/complex so we fall back to an AI estimate rather than guess.
function _parseOsmOpening(oh,dowIdx){
  if(!oh)return null;oh=oh.trim();
  if(/^24\/7$/.test(oh))return'Open 24 hours';
  if(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|sunrise|sunset|week\s*\d|\[)/i.test(oh))return null;
  let result=null;
  oh.split(';').map(s=>s.trim()).filter(Boolean).forEach(rule=>{
    const r=rule.replace(/\bPH\b/gi,'').trim();if(!r)return;
    let applies=false,rest=r;
    const dayPart=r.match(/^((?:(?:mo|tu|we|th|fr|sa|su)(?:-(?:mo|tu|we|th|fr|sa|su))?\s*,?\s*)+)/i);
    if(dayPart){
      rest=r.slice(dayPart[0].length).trim();
      dayPart[1].toLowerCase().replace(/\s+/g,'').split(',').filter(Boolean).forEach(tk=>{
        const rng=tk.split('-');
        if(rng.length===1){if(_OSM_DAY[rng[0]]===dowIdx)applies=true;}
        else{let a=_OSM_DAY[rng[0]],b=_OSM_DAY[rng[1]];if(a==null||b==null)return;let d=a;for(let k=0;k<7;k++){if(d===dowIdx){applies=true;break;}if(d===b)break;d=(d+1)%7;}}
      });
    }else applies=true;
    if(!applies)return;
    if(/\boff\b|\bclosed\b/i.test(rest)){result='closed';return;}
    const times=rest.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/g);
    if(times&&times.length){
      const parts=times.map(t=>{const mm=t.split('-').map(x=>x.trim());const a=_to12h(mm[0]),b=_to12h(mm[1]);return(a&&b)?a+' - '+b:null;}).filter(Boolean);
      if(parts.length)result=parts.join(', ');
    }
  });
  if(result==='closed')return'Closed '+_DOW_NAMES[dowIdx];
  return result;
}
// One Overpass query for the whole day; match each stop to a nearby named feature.
async function _osmHoursForDay(places,dowIdx){
  const out={};
  const withCoord=places.filter(o=>o.s.lat&&o.s.lng);
  if(!withCoord.length||dowIdx<0)return out;
  const around=withCoord.map(o=>'nwr(around:150,'+o.s.lat+','+o.s.lng+')["opening_hours"];').join('');
  const q='[out:json][timeout:20];('+around+');out tags center 100;';
  let data;
  try{
    const r=await fetch('https://overpass-api.de/api/interpreter',
      {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'data='+encodeURIComponent(q)});
    if(!r.ok)return out;data=await r.json();
  }catch(e){return out;}
  const els=((data&&data.elements)||[]).map(el=>({
    lat:el.lat!=null?el.lat:(el.center&&el.center.lat),
    lon:el.lon!=null?el.lon:(el.center&&el.center.lon),
    name:el.tags&&el.tags.name,oh:el.tags&&el.tags.opening_hours
  })).filter(e=>e.lat!=null&&e.oh);
  if(!els.length)return out;
  for(const o of withCoord){
    const key=_normPlaceName(o.s.name);let best=null,bestScore=-1;
    for(const e of els){
      const d=haversine(o.s.lat,o.s.lng,e.lat,e.lon);if(d>0.15)continue;
      const nm=e.name?_normPlaceName(e.name):'';
      // Require a NAME match — never borrow a neighbouring venue's hours just
      // because it is nearby (that would mislabel a guess as verified).
      if(!(nm&&key&&(key.includes(nm)||nm.includes(key))))continue;
      const score=100+Math.min(nm.length,key.length)+(0.2-d);
      if(score>bestScore){bestScore=score;best=e;}
    }
    if(best){const h=_parseOsmOpening(best.oh,dowIdx);if(h)out[o.si]=h;}
  }
  return out;
}
function _dayHoursHtml(s,di,si){
  if(!s.dayHours)return'';
  const closed=/\bclosed\b/i.test(s.dayHours);
  const verified=s.dayHoursSrc==='osm'||s.dayHoursSrc==='user';
  const tip=verified?'Opening hours — tap to edit':'Estimated hours — tap to correct';
  return '<div class="stop-day-hours" title="'+tip+'" onclick="editStopHours('+di+','+si+')" '+
    'style="font-family:var(--font-ui);font-size:12px;margin-top:6px;font-weight:600;cursor:pointer;color:'+(closed?'var(--ruby)':'var(--pine)')+'">'+
    '&#128337; '+_escHtml(s.dayHours)+(verified?'':' <span style="color:var(--muted);font-weight:400">(est.)</span>')+
    ' <span style="color:var(--muted);font-weight:400">&#9998;</span></div>';
}
// Re-locate a stop from its name via OpenStreetMap (free, no key) when the map
// pin is in the wrong place because of a bad stored coordinate.
async function fixStopLocation(di,si){
  const s=state.days[di]&&state.days[di].stops[si];if(!s)return;
  const q=(s.name||'').replace(/^(dinner|lunch|breakfast|brunch|coffee|drinks)\s*[—–-]\s*/i,'').replace(/\s*[—–].*/,'').trim();
  if(!q){alert('This stop has no searchable name. Edit it to set the location manually.');return;}
  try{
    const r=await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q='+encodeURIComponent(q));
    if(!r.ok)throw new Error('http');
    const d=await r.json();
    if(!d||!d[0]){alert('Could not find a location for "'+q+'". Open the stop Edit form and search for it there.');return;}
    const lat=parseFloat(d[0].lat),lng=parseFloat(d[0].lon);
    if(!confirm('Move "'+s.name+'" to:\n'+(d[0].display_name||q)+'\n('+lat.toFixed(4)+', '+lng.toFixed(4)+')?'))return;
    s.lat=lat;s.lng=lng;
    saveState('Fixed location: '+s.name);renderAll();
  }catch(e){alert('Could not reach the location service. Please try again.');}
}
// Manual correction — the reliable fix for any wrong hours.
function editStopHours(di,si){
  const s=state.days[di]&&state.days[di].stops[si];if(!s)return;
  const cur=s.dayHours||'';
  const v=prompt('Opening hours for '+s.name+' (e.g. "9:30 AM - 5:00 PM", "Closed", "Open access"):',cur);
  if(v===null)return;
  const val=v.trim();
  if(val){s.dayHours=val;s.dayHoursSrc='user';}
  else{delete s.dayHours;delete s.dayHoursSrc;}
  saveState('Edited hours: '+s.name);renderAll();
}
const HOURS_SYSTEM='You are a travel assistant with knowledge of typical opening hours for attractions, museums, restaurants, and venues worldwide. Given a list of places and a specific day of the week, return each place\'s typical opening hours ON THAT DAY. Be concise and accurate. If a place has no fixed hours (a public street, park, viewpoint, walk, or outdoor area), use "Open access". If it is normally closed on that weekday, say "Closed <weekday>". Never invent precise hours you are unsure of — use "Hours vary" instead. No commentary, no markdown.';
const _SKIP_HOURS_TYPES=['flight','train','bus','drive'];
const _hoursLoading=new Set();   // day indices with a fetch in flight
const _hoursAutoTried=new Set(); // (retained) days auto-attempted this session
const _hoursNextRetry={};        // day idx -> earliest ms to auto-retry a fill
// Core fetch. force=true refetches every place; otherwise only stops missing hours.
async function _requestDayHours(idx,force,btn){
  const day=state.days[idx];if(!day||!day.stops.length)return;
  let places=day.stops.map((s,si)=>({si,s})).filter(o=>!_SKIP_HOURS_TYPES.includes(o.s.type));
  if(!force)places=places.filter(o=>!o.s.dayHours);
  if(!places.length)return;
  const iso=dayDateStr(idx);
  const dObj=iso?new Date(iso+'T12:00:00'):null;
  const dowIdx=dObj&&!isNaN(dObj)?dObj.getDay():-1;
  const dow=dowIdx>=0?_DOW_NAMES[dowIdx]:'';
  if(btn){btn.disabled=true;btn.textContent='Finding hours…';}
  try{
    // 1) REAL hours from OpenStreetMap (accurate, no hallucination). One query.
    let osm={};
    try{ osm=await _osmHoursForDay(places,dowIdx); }catch(e){}
    // Never overwrite hours the user edited by hand — even on a manual refresh.
    places.forEach(o=>{ if(osm[o.si] && o.s.dayHoursSrc!=='user'){o.s.dayHours=osm[o.si];o.s.dayHoursSrc='osm';o._done=true;} });
    // 2) AI estimate only for places OSM could not resolve. Never overwrite a
    //    hours value the user edited by hand. If the AI call fails (e.g. usage
    //    limit), keep the REAL OSM hours we already have — do NOT abort, or the
    //    whole day would show no hours even though OSM resolved several.
    const remaining=places.filter(o=>!o._done&&o.s.dayHoursSrc!=='user');
    if(remaining.length){
      try{
        let prompt='Day of week: '+(dow||'unknown')+(iso?' ('+iso+')':'')+'\nArea/context: '+day.title+'\n\nPlaces (in order):\n';
        remaining.forEach((o,i)=>{prompt+=(i+1)+'. '+o.s.name+'\n';});
        prompt+='\nReturn ONLY a JSON array with one object per place, in the SAME order:\n[{"hours":"<opening hours on '+(dow||'that day')+'>"}]\nExample values: "9:00 AM - 5:00 PM", "10:00 AM - 6:00 PM", "Closed '+(dow||'')+'", "Open access", "Open 24 hours", "Hours vary".';
        const text=await callClaude(HOURS_SYSTEM,prompt);
        const t=text.trim().replace(/```(?:json)?/gi,'').replace(/```/g,'').trim();
        const a=t.indexOf('['),b=t.lastIndexOf(']');
        const arr=JSON.parse(a>=0&&b>a?t.slice(a,b+1):t);
        if(Array.isArray(arr)){
          remaining.forEach((o,i)=>{
            const it=arr[i];const hrs=it&&(typeof it==='string'?it:it.hours);
            if(hrs&&String(hrs).trim()){o.s.dayHours=String(hrs).trim();o.s.dayHoursSrc='ai';}
          });
        }
      }catch(aiErr){ /* AI unavailable — keep OSM hours, fill the rest later */ }
    }
    places.forEach(o=>{delete o._done;});
    saveState('Added opening hours for '+day.title,true); // derived data — local only, don't race the cloud
    renderAll();
  }catch(e){
    if(btn){btn.disabled=false;btn.innerHTML='&#128337; Hours';}
    throw e;
  }
}
// Manual button: refetch hours for every place on the day.
function addDayOpeningHours(idx){
  const day=state.days[idx];
  if(day&&!day.stops.some(s=>!_SKIP_HOURS_TYPES.includes(s.type))){alert('No places on this day to look up hours for.');return;}
  _requestDayHours(idx,true,document.getElementById('hours-btn-'+idx))
    .catch(()=>alert('Could not fetch opening hours. Please try again.'));
}
// Auto: when a day is viewed, fill in any missing hours quietly. Unlike before,
// this does NOT give up permanently after one attempt — if a fetch failed or
// only partially filled (e.g. AI was down), it retries on later views (with a
// short cooldown so it never hammers), so opening times appear by default
// without the user ever asking. It stops on its own once every place has hours.
function autoLoadDayHours(idx){
  if(_hoursLoading.has(idx))return;
  const day=state.days[idx];if(!day)return;
  if(!day.stops.some(s=>!_SKIP_HOURS_TYPES.includes(s.type)&&!s.dayHours))return;
  const now=Date.now();
  if(_hoursNextRetry[idx]&&now<_hoursNextRetry[idx])return;
  _hoursNextRetry[idx]=now+30000;   // don't retry this same day for 30s
  _hoursLoading.add(idx);
  _requestDayHours(idx,false).catch(()=>{}).finally(()=>_hoursLoading.delete(idx));
}
function _stopPlaceMetaHtml(s){
  if(!s.website&&!s.phone&&!s.openingHours)return'';
  let h='<div class="stop-place-meta">';
  if(s.openingHours){
    const arr=Array.isArray(s.openingHours)?s.openingHours:Object.values(s.openingHours);
    const todayTxt=arr[(new Date().getDay()+6)%7]||''; // weekday_text is Monday-indexed
    if(todayTxt){
      const closed=/closed/i.test(todayTxt);
      const display=todayTxt.replace(/^[^:]*:\s*/,'');
      h+='<span class="'+(closed?'hours-closed':'hours-open')+'">&#128337; '+(closed?'Closed today':display)+'</span>';
    }
  }
  if(_safeUrl(s.website))h+=(s.openingHours?' &middot; ':'')+'<a href="'+_escHtml(_safeUrl(s.website))+'" target="_blank" rel="noopener">&#127760; Website</a>';
  if(s.phone)h+='<span style="display:block">&#128222; '+_escHtml(s.phone)+'</span>';
  h+='</div>';
  return h;
}

/* --- AI Itinerary Grader --- */
const GRADE_SYSTEM='You are a seasoned travel editor reviewing an itinerary the way a Condé Nast editor would — direct, specific, and focused on what will make or break the experience. Core question: does this itinerary hit the must-see sights, or are iconic experiences being missed?\n\nReturn ONLY valid JSON (no markdown, no code blocks):\n{"overall_grade":{"letter":"B+","rationale":"one sentence: biggest strength and biggest gap"},"destination_coverage":[{"destination":"London","score":"8/10","note":"Missing Tate Modern — fits Day 2 afternoon near Globe Theatre"}],"suggested_swaps":[{"remove":"stop name","day":1,"add":"replacement name","reason":"specific reason replacement is clearly better for this time slot and location"}],"suggested_additions":[{"name":"","type":"","reason":"","suggested_day":1,"fits_near":"name of existing nearby stop"}],"pacing_notes":["observation only — never a removal suggestion"],"timing_conflicts":[{"stop_name":"","day":1,"issue":""}]}\n\nRules:\n1. NEVER suggest removing a top-tier attraction (major museums, iconic landmarks, historic castles, world-famous sites) unless genuinely duplicated.\n2. Every entry in suggested_swaps MUST include both remove AND add fields — no incomplete swaps.\n3. suggested_additions MUST name a specific fits_near stop and a specific day with capacity.\n4. pacing_notes are observations only — never suggest removing stops in them.\n5. Account for trip duration: 2-day city visit needs different priorities than 5-day.\n6. destination_coverage: score each distinct destination. Be specific about what iconic experience is missing.\n7. Tone: experienced travel editor, not a cautious assistant. Be direct.';
async function gradeItinerary(){
  const modal=document.getElementById('ai-grader-modal');
  const content=document.getElementById('ai-grader-content');
  modal.classList.add('open');
  content.innerHTML='<div class="ai-loading-wrap"><span class="ai-loading-spinner">&#8635;</span><div style="font-family:var(--font-ui);font-size:13px;color:var(--muted)">Analyzing your itinerary…</div></div>';
  try{
    let prompt='CRITICAL: The itinerary is ONLY the numbered stops listed under each day. A day heading or a stop note may still mention a place that has ALREADY BEEN REMOVED from the plan — treat headings and notes as labels/context only. NEVER recommend removing, replacing, or swapping anything that is not present as a numbered stop, and never state a place is in the plan unless it appears as a numbered stop.\n\n';
    prompt+='Trip: '+(state.title||'Unknown')+'\nDays: '+state.days.length+'\n\n';
    state.days.forEach((d,di)=>{
      const dp=(d.subtitle||'').split(/\s*[·•]\s*/)[0].trim();
      prompt+='Day '+(di+1)+' — '+d.title+(dp?' ('+dp+')':'')+'\n';
      d.stops.forEach((s,si)=>{
        prompt+='  '+(si+1)+'. '+s.name+' ['+s.type+']'+(s.time?' @'+s.time:'');
        if(s.openingHours)prompt+=' hours:'+JSON.stringify(s.openingHours);
        if(s.notes)prompt+=' | '+s.notes;
        prompt+='\n';
      });
    });
    const text=await callClaude(GRADE_SYSTEM,prompt);
    const t=text.trim().replace(/```(?:json)?/gi,'').replace(/```/g,'').trim();
    const js=t.indexOf('{'),je=t.lastIndexOf('}');
    const data=JSON.parse(js>=0&&je>js?t.slice(js,je+1):t);
    content.innerHTML=_renderGradeResult(data);
  }catch(e){
    content.innerHTML='<div class="ai-loading-wrap" style="color:var(--ruby)">Could not grade — please try again.</div>';
  }
}
function _gradeColor(l){
  const g=(l||'?').charAt(0).toUpperCase();
  return g==='A'?'#1F5C3A':g==='B'?'var(--river)':g==='C'?'var(--amber)':'var(--ruby)';
}
function _renderGradeResult(d){
  const g=d.overall_grade||{};
  let h='<div class="ai-modal-grade-row">'+
    '<div class="ai-grade-letter" style="background:'+_gradeColor(g.letter)+'">'+_escHtml(g.letter||'?')+'</div>'+
    '<div class="ai-grade-rationale">'+_escHtml(g.rationale||'')+'</div></div>';
  if(d.destination_coverage?.length){
    h+='<div class="ai-section"><div class="ai-section-hdr">&#127758; Coverage by Destination</div>';
    d.destination_coverage.forEach(c=>{
      h+='<div class="ai-item"><strong>'+_escHtml(c.destination||'')+'</strong>: <span style="color:var(--pine);font-weight:600">'+_escHtml(c.score||'')+'</span> must-sees'+(c.note?' <span style="color:var(--muted)">— '+_escHtml(c.note)+'</span>':'')+'</div>';
    });h+='</div>';
  }
  if(d.pacing_notes?.length){
    h+='<div class="ai-section"><div class="ai-section-hdr">&#128203; Pacing Notes</div>';
    d.pacing_notes.forEach(n=>h+='<div class="ai-item">'+_escHtml(n)+'</div>');h+='</div>';
  }
  if(d.timing_conflicts?.length){
    h+='<div class="ai-section"><div class="ai-section-hdr">&#9888;&#65039; Timing Issues</div>';
    d.timing_conflicts.forEach(c=>h+='<div class="ai-item ai-item-warn"><strong>Day '+c.day+': '+_escHtml(c.stop_name||'')+'</strong> &mdash; '+_escHtml(c.issue||'')+'</div>');h+='</div>';
  }
  if(d.suggested_additions?.length){
    h+='<div class="ai-section"><div class="ai-section-hdr">&#10024; Consider Adding</div>';
    d.suggested_additions.forEach(a=>h+='<div class="ai-item" style="border-left:3px solid var(--pine)"><strong>'+_escHtml(a.name||'')+'</strong> <em>('+_escHtml(a.type||'')+', Day '+a.suggested_day+')</em><br>'+_escHtml(a.reason||'')+(a.fits_near?' <span style="color:var(--muted);font-size:11.5px">&#128205; Near '+_escHtml(a.fits_near)+'</span>':'')+'</div>');h+='</div>';
  }
  if(d.suggested_swaps?.length){
    h+='<div class="ai-section"><div class="ai-section-hdr">&#8644; Consider Swapping</div>';
    d.suggested_swaps.forEach(r=>{
      h+='<div class="ai-item" style="border-left:3px solid var(--amber)">'+
        '<span style="color:var(--ruby)">&#10007; Day '+r.day+': <strong>'+_escHtml(r.remove||'')+'</strong></span><br>'+
        '<span style="color:var(--pine)">&#10003; Replace with <strong>'+_escHtml(r.add||'')+'</strong></span><br>'+
        '<span style="color:var(--muted);font-size:12px">'+_escHtml(r.reason||'')+'</span></div>';
    });h+='</div>';
  }
  /* backward-compat: old suggested_removals field */
  if(!d.suggested_swaps?.length&&d.suggested_removals?.length){
    h+='<div class="ai-section"><div class="ai-section-hdr">&#9986;&#65039; Consider Removing</div>';
    d.suggested_removals.forEach(r=>h+='<div class="ai-item" style="border-left:3px solid var(--ruby)"><strong>Day '+r.day+': '+_escHtml(r.stop_name||'')+'</strong> &mdash; '+_escHtml(r.reason||'')+'</div>');h+='</div>';
  }
  return h;
}

/* --- AI Day Optimizer --- */
const OPT_SYSTEM='You are an expert travel logistics checker. Judge ONLY whether the day can physically be done. Do NOT judge pace, vibe, or how rushed or relaxed the day feels, and NEVER suggest adding filler or removing stops to change the pace or add downtime.\n\nReturn ONLY valid JSON (no markdown, no code blocks):\n{"optimization_score":78,"score_summary":"one sentence: whether the day is doable and the single biggest logistical issue","sub_scores":{"route":85,"hours":70,"travel":80,"feasibility":75},"optimized_order":[{"name":"","rationale":""}],"timing_issues":[{"stop_name":"","issue":"","suggestion":""}],"route_notes":"string","proposed_moves":[{"stop_name":"","from_day":1,"to_day":2,"reason":""}]}\n\nScore definitions (each 0-100, their average = optimization_score):\n- route: geographic efficiency -- stops in a logical order that minimizes backtracking and distance.\n- hours: are the stops OPEN when the traveler arrives -- respect opening hours and days closed.\n- travel: is the travel between consecutive stops realistic given the mode of transport, the distance, and typical traffic.\n- feasibility: can the WHOLE day be completed -- every stop reached while it is open, with enough time to travel between stops and visit each one.\n\nHard rules:\n- Do NOT assume or comment on pace. Never say a day is too rushed, too packed, too ambitious, too slow, or too empty.\n- Do NOT suggest adding or removing stops for pacing or downtime. Suggest a change ONLY when a stop would be CLOSED at the planned time, or cannot be reached in time given travel mode, distance, and traffic.\n- optimized_order: reorder ONLY to cut backtracking or to arrive while a stop is open. If the order already works, return it unchanged.\n- timing_issues: list ONLY concrete problems: (a) a stop CLOSED at its planned time or closed that weekday; (b) a leg where travel time plus visit time makes the next stop impossible to reach while open; (c) a MEAL at an odd time -- lunch before 11:30am or after 2:30pm, or dinner before 5:30pm; (d) a DUPLICATE meal -- more than one lunch or more than one dinner on the same day; (e) an OVERPACKED day whose stops plus travel cannot fit the waking hours (for example 11 stops in 12 hours). For each, name the stop and state the concrete facts (open/closed, travel mode, distance, approximate travel time). If there are none, return an empty array.\n\nThresholds: 90-100=Fully Doable, 75-89=Doable, 50-74=Tight, 0-49=Not Feasible.\nproposed_moves: optional cross-day moves ONLY if a stop cannot be done on its current day (closed or unreachable) but works on an adjacent day. Omit if none. Use 1-based day numbers.';
async function optimizeDay(idx){
  const modal=document.getElementById('ai-optimizer-modal');
  const content=document.getElementById('ai-optimizer-content');
  const day=state.days[idx];if(!day)return;
  _optDayIdx=idx;_optLastData=null;
  modal.classList.add('open');
  content.innerHTML='<div class="ai-loading-wrap"><span class="ai-loading-spinner">&#8635;</span><div style="font-family:var(--font-ui);font-size:13px;color:var(--muted)">Optimizing your day…</div></div>';
  try{
    const dp=(day.subtitle||'').split(/\s*[·•]\s*/)[0].trim();
    const dd=dp?(_parseTripDate(dp)||new Date(dp+' 12:00')):null;
    const dow=dd&&!isNaN(dd)?['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dd.getDay()]:'';
    let prompt='CRITICAL: the day is ONLY the numbered stops below. The day title or a note may still mention a place already REMOVED — treat titles/notes as labels only and never recommend removing/replacing anything that is not a numbered stop.\n\n';
    prompt+='Day: '+day.title+(dow?'\nDay of week: '+dow:'')+'\nStops:\n';
    day.stops.forEach((s,si)=>{
      prompt+=(si+1)+'. '+s.name+' ['+s.type+']'+(s.time?' @'+s.time:'');
      if(s.lat&&s.lng)prompt+=' ('+Number(s.lat).toFixed(4)+','+Number(s.lng).toFixed(4)+')';
      if(s.dayHours)prompt+='\n   Open today: '+s.dayHours;
      if(s.openingHours)prompt+='\n   Hours: '+JSON.stringify(s.openingHours);
      if(s.reservation)prompt+='\n   Reservation: '+s.reservation;
      if(s.notes)prompt+='\n   Notes: '+s.notes;
      prompt+='\n';
    });
    const text=await callClaude(OPT_SYSTEM,prompt);
    const t=text.trim().replace(/```(?:json)?/gi,'').replace(/```/g,'').trim();
    const js=t.indexOf('{'),je=t.lastIndexOf('}');
    const data=JSON.parse(js>=0&&je>js?t.slice(js,je+1):t);
    content.innerHTML=_renderOptResult(data);
  }catch(e){
    content.innerHTML='<div class="ai-loading-wrap" style="color:var(--ruby)">Could not optimize — please try again.</div>';
  }
}
function _optScoreColor(s){
  if(s>=90)return'#1F5C3A';
  if(s>=75)return'var(--pine)';
  if(s>=50)return'var(--amber)';
  return'var(--ruby)';
}
function _optScoreLabel(s){
  if(s>=90)return'Fully Doable';
  if(s>=75)return'Doable';
  if(s>=50)return'Tight';
  return'Not Feasible';
}
function _renderOptResult(d){
  _optLastData=d;
  let h='';
  if(d.optimization_score!==undefined){
    const score=Math.max(0,Math.min(100,Math.round(d.optimization_score)));
    const color=_optScoreColor(score);
    const ss=d.sub_scores||{};
    const pills=['route','hours','travel','feasibility'].map(k=>{
      const v=ss[k]!==undefined?Math.round(ss[k]):'—';
      return'<span class="opt-subscore-pill">'+k.charAt(0).toUpperCase()+k.slice(1)+' '+v+'</span>';
    }).join('');
    h+='<div class="opt-score-row">'+
      '<div class="opt-score-badge" style="background:'+color+'">'+
      '<div class="opt-score-num">'+score+'</div>'+
      '<div class="opt-score-label">'+_optScoreLabel(score)+'</div>'+
      '</div>'+
      '<div class="opt-score-info">'+
      (d.score_summary?'<div class="opt-score-summary">'+_escHtml(d.score_summary)+'</div>':'')+
      '<div class="opt-subscores">'+pills+'</div>'+
      '</div></div>';
  }
  if(d.route_notes)h+='<div class="ai-section"><div class="ai-section-hdr">&#128506; Route Overview</div><div class="ai-item">'+_escHtml(d.route_notes)+'</div></div>';
  if(d.optimized_order?.length){
    h+='<div class="ai-section"><div class="ai-section-hdr">&#9989; Suggested Order</div>';
    d.optimized_order.forEach((o,i)=>{
      const name=typeof o==='string'?o:(o.name||'');
      const rat=typeof o==='object'?o.rationale:'';
      h+='<div class="ai-item"><strong>'+(i+1)+'. '+_escHtml(name)+'</strong>'+(rat?' <span style="color:var(--muted);font-size:11.5px">&mdash; '+_escHtml(rat)+'</span>':'')+'</div>';
    });
    h+='<div id="opt-apply-wrap"><button class="opt-apply-btn" onclick="showApplyOrderConfirm()">&#10003; Apply This Order</button></div>';
    h+='</div>';
  }
  if(d.timing_issues?.length){
    h+='<div class="ai-section"><div class="ai-section-hdr">&#9888;&#65039; Timing Issues</div>'+
      '<p style="font-family:var(--font-ui);font-size:11px;color:var(--muted);margin-bottom:8px;font-style:italic">AI checks typical hours — verify directly with venues.</p>';
    d.timing_issues.forEach((t,ti)=>{
      h+='<div class="ai-item ai-item-warn"><strong>'+_escHtml(t.stop_name||'')+'</strong>: '+_escHtml(t.issue||'')+(t.suggestion?' <em>&rarr; '+_escHtml(t.suggestion)+'</em>':'')+
        '<div><button class="opt-fix-btn" onclick="showTimingFix('+ti+')">&#9889; Fix This</button></div></div>';
    });
    h+='</div>';
  }
  if(d.proposed_moves?.length){
    h+='<div class="opt-moves-section"><div class="ai-section-hdr">&#8646; Proposed Day Moves</div>';
    d.proposed_moves.forEach((m,mi)=>{
      h+='<div class="opt-move-row">'+
        '<div class="opt-move-info">'+
        '<div class="opt-move-from"><strong>'+_escHtml(m.stop_name||'')+'</strong></div>'+
        '<div style="font-family:var(--font-ui);font-size:11px;color:var(--muted)">Day '+m.from_day+' <span class="opt-move-to">Day '+m.to_day+'</span></div>'+
        '<div class="opt-move-reason">'+_escHtml(m.reason||'')+'</div>'+
        '</div>'+
        '<button class="opt-move-btn" onclick="applyProposedMove('+mi+')">Apply</button>'+
        '</div>';
    });
    if(d.proposed_moves.length>1)h+='<button class="opt-apply-all-btn" onclick="applyAllProposedMoves()">Apply All Moves</button>';
    h+='</div>';
  }
  return h||'<div class="ai-item">No issues found -- your day looks well-optimized!</div>';
}
function showApplyOrderConfirm(){
  const wrap=document.getElementById('opt-apply-wrap');if(!wrap)return;
  const order=(_optLastData?.optimized_order||[]).map(o=>typeof o==='string'?o:(o.name||''));
  wrap.innerHTML='<div class="opt-confirm-bar">Reorder '+order.length+' stops on Day '+(_optDayIdx+1)+'?'+
    '<div class="opt-confirm-actions">'+
    '<button class="add-check-btn" style="padding:6px 14px;font-size:12px" onclick="applyOptimizedOrder()">Yes, Apply</button>'+
    '<button class="chk-edit-btn" style="font-size:13px;padding:0 8px" onclick="cancelApplyOrder()">Cancel</button>'+
    '</div></div>';
}
function cancelApplyOrder(){
  const wrap=document.getElementById('opt-apply-wrap');
  if(wrap)wrap.innerHTML='<button class="opt-apply-btn" onclick="showApplyOrderConfirm()">&#10003; Apply This Order</button>';
}
function applyOptimizedOrder(){
  const idx=_optDayIdx;
  if(idx<0||!_optLastData?.optimized_order)return;
  const day=state.days[idx];if(!day)return;
  const savedStops=day.stops.map(s=>({...s}));
  const order=(_optLastData.optimized_order||[]).map(o=>typeof o==='string'?o:(o.name||''));
  const newStops=[];const used=new Set();
  order.forEach(name=>{
    const key=(name||'').toLowerCase().trim();
    if(!key)return; // an empty name would match the first stop — skip it
    const si=day.stops.findIndex((s,i)=>!used.has(i)&&s.name.toLowerCase().includes(key.slice(0,18)));
    if(si>=0){newStops.push(day.stops[si]);used.add(si);}
  });
  day.stops.forEach((s,i)=>{if(!used.has(i))newStops.push(s);});
  day.stops=newStops;
  // Rewrite times to match the new order — otherwise the render-time chrono sort
  // immediately reverts this reorder (times still imply the old sequence).
  _recalcDayTimes(idx,_dayStartAnchor(newStops));
  saveState('Applied optimized order');
  document.getElementById('ai-optimizer-modal').classList.remove('open');
  renderAll();
  showUndoBanner('Day '+( idx+1)+' stops reordered.',()=>{
    const d=state.days[idx];if(d){d.stops=savedStops;saveState('Undid optimizer changes');renderAll();}
  });
}
// Sort a day chronologically by start time. Stops WITHOUT a time stay anchored
// just after the previous timed stop (carry-forward) instead of being dumped at
// the end — so a timeless stop never jumps out of chronological order.
function _sortDayByTime(dayIdx){
  const day=state.days[dayIdx];const stops=day&&day.stops;if(!stops||stops.length<2)return;
  const timed=stops.filter(s=>_parseTimeMins(s.time)!==null);
  if(timed.length<2)return;
  let last=-1;
  const arr=stops.map((s,i)=>{
    let m=_parseTimeMins(s.time);
    if(m===null){ m=(last>=0?last:0)+0.001; }   // keep with the preceding timed stop
    else last=m;
    return {s,i,m};
  });
  arr.sort((a,b)=>(a.m-b.m)||(a.i-b.i));
  day.stops=arr.map(x=>x.s);
}
// Re-order every day chronologically (used on load so a trip synced/edited out of
// order self-corrects on open).
function _sortAllDaysByTime(){
  if(!state||!state.days)return;
  for(let i=0;i<state.days.length;i++)_sortDayByTime(i);
}
// Invariant check: are the TIMED stops of a day in non-decreasing time order?
// Untimed stops are allowed anywhere (they carry-forward). Returns the 1-based
// day number of the FIRST violation, or 0 if every day is chronological.
function _firstChronoViolation(){
  if(!state||!state.days)return 0;
  for(let d=0;d<state.days.length;d++){
    let last=-1;
    for(const s of (state.days[d].stops||[])){
      const m=_parseTimeMins(s.time);
      if(m===null)continue;
      if(m<last)return d+1;
      last=m;
    }
  }
  return 0;
}
function _extractTimeFromText(text){
  if(!text)return null;
  const m=text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)||text.match(/\b(\d{1,2}):(\d{2})\b/);
  if(!m)return null;
  let h=parseInt(m[1]),mn=parseInt(m[2]||0);
  const ap=(m[3]||'').toLowerCase();
  if(ap==='pm'&&h!==12)h+=12;
  if(ap==='am'&&h===12)h=0;
  if(!ap&&h<7)h+=12;
  return(h<10?'0'+h:h)+':'+(mn<10?'0'+mn:mn);
}
function showTimingFix(ti){
  if(!_optLastData?.timing_issues?.[ti])return;
  const issue=_optLastData.timing_issues[ti];
  if(_optDayIdx<0)return;
  const day=state.days[_optDayIdx];if(!day)return;
  const _k=(issue.stop_name||'').toLowerCase().trim();if(!_k)return; // empty name would match the first stop
  const si=day.stops.findIndex(s=>s.name.toLowerCase().includes(_k.slice(0,15)));
  if(si<0)return;
  const suggestedTime=_extractTimeFromText(issue.suggestion);
  if(suggestedTime){
    const savedStop={...day.stops[si]};
    const savedOrder=day.stops.map(s=>({...s}));
    day.stops[si]={...day.stops[si],time:suggestedTime};
    _sortDayByTime(_optDayIdx);
    saveState('Fixed timing issue');
    document.getElementById('ai-optimizer-modal').classList.remove('open');
    renderAll();
    showUndoBanner('Set "'+_escHtml(issue.stop_name||day.stops[si]?.name||'')+'" → '+suggestedTime,()=>{
      state.days[_optDayIdx].stops=savedOrder;saveState('Undid timing fix');renderAll();
    });
  }else{
    document.getElementById('ai-optimizer-modal').classList.remove('open');
    setTimeout(()=>openEditStopModal(_optDayIdx,si),150);
  }
}
function showUndoBanner(msg,undoFn){
  const banner=document.getElementById('undo-banner');if(!banner)return;
  document.getElementById('undo-banner-text').textContent='↩ '+msg;
  _lastUndoFn=undoFn||null;
  banner.classList.add('visible');
  if(_optUndoTimer)clearTimeout(_optUndoTimer);
  _optUndoTimer=setTimeout(()=>banner.classList.remove('visible'),60000);
}
function undoLastChange(){
  if(_lastUndoFn){_lastUndoFn();_lastUndoFn=null;}
  const banner=document.getElementById('undo-banner');
  if(banner)banner.classList.remove('visible');
  if(_optUndoTimer){clearTimeout(_optUndoTimer);_optUndoTimer=null;}
}

/* --- Restaurant Alternates --- */
const ALT_SYSTEM='You are a restaurant recommendation expert. Given a current restaurant and travel context, suggest 3 nearby alternatives. Return ONLY a JSON array, no markdown.\nFormat: [{"name":"Restaurant Name","cuisine":"Italian","price_tier":2,"distance_estimate":"5 min walk","why_recommended":"one sentence","google_maps_search_url":"https://www.google.com/maps/search/Restaurant+Name+City+Name","approximate_wait_or_reservation_needed":"Walk-in ok / Reservations recommended"}]\nprice_tier: 1=Budget (<$15/person), 2=Mid-range ($15-40), 3=Fine Dining (>$40).\nBe specific and practical — focus on restaurants that complement the day\'s itinerary.';
async function showAlternates(dayIdx,stopIdx){
  const modal=document.getElementById('alternates-modal');
  const content=document.getElementById('alternates-content');
  if(!modal||!content)return;
  const day=state.days[dayIdx];const stop=day?.stops[stopIdx];if(!day||!stop)return;
  _altDayIdx=dayIdx;_altStopIdx=stopIdx;_altResults=[];
  modal.classList.add('open');
  content.innerHTML='<div class="ai-loading-wrap"><span class="ai-loading-spinner">&#8635;</span><div style="font-family:var(--font-ui);font-size:13px;color:var(--muted)">Finding alternates…</div></div>';
  try{
    const cityCtx=day.title.replace(/^Day \d+\s*[—–]\s*/,'');
    const otherStops=day.stops.map(s=>s.name).filter(n=>n!==stop.name).join(', ');
    const prompt='Current restaurant: '+stop.name+'\nCity/area: '+cityCtx+'\nOther stops today: '+otherStops+(stop.notes?'\nNotes: '+stop.notes:'')+(stop.stars?'\nRating: '+stop.stars+' stars':'');
    const text=await callClaude(ALT_SYSTEM,prompt);
    const t=text.trim().replace(/```(?:json)?/gi,'').replace(/```/g,'').trim();
    const js=t.indexOf('['),je=t.lastIndexOf(']');
    _altResults=JSON.parse(js>=0&&je>js?t.slice(js,je+1):t);
    content.innerHTML='<p style="font-family:var(--font-ui);font-size:12px;color:var(--muted);margin-bottom:14px">Alternatives to <strong>'+_escHtml(stop.name)+'</strong></p>'+
      _renderAlternates(_altResults,dayIdx,stopIdx);
  }catch(e){
    content.innerHTML='<div style="color:var(--ruby);font-family:var(--font-ui);font-size:13px">Could not find alternates — please try again.</div>';
  }
}
function _renderAlternates(alts,dayIdx,stopIdx){
  if(!alts?.length)return'<div class="ov-empty">No alternates found.</div>';
  return alts.map((a,ai)=>{
    const tier=a.price_tier||2;
    const tierCls=tier<=1?'alt-price-budget':tier>=3?'alt-price-fine':'alt-price-mid';
    const tierSym=tier<=1?'$':tier>=3?'$$$':'$$';
    const tierLabel=tier<=1?'Budget':tier>=3?'Fine Dining':'Mid-range';
    return'<div class="alt-card">'+
      '<div class="alt-card-name">'+_escHtml(a.name||'')+'</div>'+
      '<div class="alt-card-meta">'+
      '<span class="alt-price-badge '+tierCls+'">'+tierSym+' '+tierLabel+'</span>'+
      _escHtml(a.cuisine||'')+(a.distance_estimate?' &middot; '+_escHtml(a.distance_estimate):'')+
      '</div>'+
      (a.why_recommended?'<div class="alt-card-why">'+_escHtml(a.why_recommended)+'</div>':'')+
      (a.approximate_wait_or_reservation_needed?'<div style="font-family:var(--font-ui);font-size:11px;color:var(--amber);margin-bottom:8px">&#9201; '+_escHtml(a.approximate_wait_or_reservation_needed)+'</div>':'')+
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'+
      '<button class="alt-use-btn" onclick="confirmApplyAlternate('+dayIdx+','+stopIdx+','+ai+')">&#10003; Use This Instead</button>'+
      (a.google_maps_search_url?'<a class="map-link" href="'+_escHtml(a.google_maps_search_url)+'" target="_blank" rel="noopener">&#128205; Maps</a>':'')+
      '</div></div>';
  }).join('');
}
function confirmApplyAlternate(dayIdx,stopIdx,altIdx){
  const alt=_altResults[altIdx];if(!alt)return;
  const day=state.days[dayIdx];const stop=day?.stops[stopIdx];if(!day||!stop)return;
  const origStop={...stop};
  stop.name=alt.name;
  stop.notes=('AI Suggested Alternate: Originally "'+origStop.name+'"'+(origStop.notes?' | '+origStop.notes:'')).trim();
  stop.reservation='';
  // Clear the OLD venue's place data so the pin/photo/hours/links don't linger.
  ['lat','lng','desc','openingHours','dayHours','dayHoursSrc','website','phone','customImage','stars'].forEach(k=>{delete stop[k];});
  if(alt.google_maps_search_url)stop.url=alt.google_maps_search_url; else delete stop.url;
  stop.recentlyChanged=true;
  saveState('Applied restaurant alternate');
  document.getElementById('alternates-modal').classList.remove('open');
  renderAll();
  showUndoBanner('"'+alt.name+'" applied.',()=>{
    const d=state.days[dayIdx];if(d?.stops?.[stopIdx]){Object.assign(d.stops[stopIdx],origStop);delete d.stops[stopIdx].recentlyChanged;saveState('Undid restaurant alternate');renderAll();}
  });
}

/* --- Share Trip --- */
function openShareModal(){
  const url=location.origin+location.pathname+'?id='+encodeURIComponent(tripId)+'&view=readonly';
  document.getElementById('share-url-input').value=url;
  document.getElementById('share-modal').classList.add('open');
}
function copyShareUrl(){
  const inp=document.getElementById('share-url-input');
  navigator.clipboard.writeText(inp.value).then(()=>showToast('Link copied!')).catch(()=>{inp.select();document.execCommand('copy');showToast('Link copied!');});
}

/* --- Multi-Traveler Attendance --- */
function getTravelers(){return(state.travelers||[]).filter(t=>t&&t.trim());}
function openTravelersModal(){
  document.getElementById('travelers-input').value=getTravelers().join('\n');
  document.getElementById('travelers-modal').classList.add('open');
}
function saveTravelers(){
  const val=document.getElementById('travelers-input').value;
  state.travelers=val.split('\n').map(t=>t.trim()).filter(Boolean);
  saveState('Updated travelers');
  document.getElementById('travelers-modal').classList.remove('open');
  renderAll();
}
function _populateTravelersForm(stop){
  const travelers=getTravelers();
  const sec=document.getElementById('f-travelers-section');
  const box=document.getElementById('f-travelers-checkboxes');
  if(!sec||!box)return;
  if(!travelers.length){sec.style.display='none';return;}
  sec.style.display='';
  const att=stop?stop.attendance||travelers:travelers;
  box.innerHTML=travelers.map(t=>
    '<label style="display:flex;align-items:center;gap:8px;font-family:var(--font-ui);font-size:13px;cursor:pointer">'+
    '<input type="checkbox" '+(att.includes(t)?'checked':'')+' value="'+_escHtml(t)+'" style="width:15px;height:15px;accent-color:var(--river)"/>'+
    _escHtml(t)+'</label>'
  ).join('');
}
function _getAttendanceFromForm(){
  const travelers=getTravelers();
  if(!travelers.length)return undefined;
  const checked=[...document.querySelectorAll('#f-travelers-checkboxes input:checked')].map(i=>i.value);
  return checked.length?checked:travelers;
}
function _attendanceHtml(stop){
  const travelers=getTravelers();
  if(!travelers.length)return'';
  const att=stop.attendance||travelers;
  return'<div class="traveler-attend-row">'+travelers.map(t=>'<span class="t-chip '+(att.includes(t)?'t-chip-in':'t-chip-out')+'">'+_escHtml(t)+'</span>').join('')+'</div>';
}

/* --- Flight Check-in Links --- */
const CHECKIN_URLS={
  'AA':'https://www.aa.com/checkin','DL':'https://www.delta.com/us/en/check-in/overview',
  'UA':'https://www.united.com/ual/en/us/checkin','WN':'https://www.southwest.com/flight/retrieveCheckinDoc.html',
  'BA':'https://www.britishairways.com/en-gb/information/airport-information/check-in-online',
  'LH':'https://www.lufthansa.com/us/en/online-check-in','AF':'https://checkin.airfrance.fr',
  'KL':'https://www.klm.com/us/en/check-in','EK':'https://www.emirates.com/us/english/manage-booking/online-check-in/',
  'QR':'https://www.qatarairways.com/en-us/check-in.html','SQ':'https://www.singaporeair.com/en_UK/sg/travel-info/check-in/',
  'AC':'https://www.aircanada.com/ca/en/aco/home/book/checkin.html','VS':'https://www.virginatlantic.com/us/en/flying-with-us/check-in.html',
  'EI':'https://www.aerlingus.com/travelinformation/airportinformation/checkinonline/','FR':'https://www.ryanair.com/us/en/plan-trip/check-in',
  'U2':'https://www.easyjet.com/en/check-in','IB':'https://www.iberia.com/us/check-in/',
  'AY':'https://www.finnair.com/us-en/check-in','TK':'https://www.turkishairlines.com/en-us/flights/flight-checkin/',
  'B6':'https://www.jetblue.com/flying-with-us/check-in','AS':'https://www.alaskaair.com/content/travel-info/boarding-deplaning/check-in',
  'NK':'https://checkin.spirit.com/','DY':'https://www.norwegian.com/us/check-in/',
  'WS':'https://www.westjet.com/en-us/check-in','NH':'https://www.ana.co.jp/en/us/travel-information/check-in/',
};
function _checkinLink(flightNumber,airline){
  let code=null;
  if(flightNumber){const m=flightNumber.trim().match(/^([A-Z][A-Z0-9]{1,2})\s*\d/i);if(m)code=m[1].toUpperCase();}
  if(!code)return'';
  const url=CHECKIN_URLS[code];
  if(!url)return'';
  return'<a class="map-link" href="'+url+'" target="_blank" rel="noopener">&#128745; Check In</a>';
}

/* --- Swipe Gestures --- */
(function(){
  let tx=0,ty=0,live=false;
  const skip=e=>!!e.target.closest('#map,.modal,.modal-overlay,textarea,input,select,.card-controls,[data-no-swipe]');
  document.addEventListener('touchstart',e=>{
    if(skip(e))return;
    tx=e.touches[0].clientX;ty=e.touches[0].clientY;live=true;
  },{passive:true});
  document.addEventListener('touchmove',e=>{
    if(!live||skip(e))return;
    const dx=Math.abs(e.touches[0].clientX-tx),dy=Math.abs(e.touches[0].clientY-ty);
    if(dx>dy&&dx>30)e.preventDefault();
  },{passive:false});
  document.addEventListener('touchend',e=>{
    if(!live)return;live=false;
    if(skip(e))return;
    const dx=e.changedTouches[0].clientX-tx,dy=e.changedTouches[0].clientY-ty;
    if(Math.abs(dx)<30||Math.abs(dx)<=Math.abs(dy))return;
    if(currentDayIdx===-1)return;
    if(dx<0&&currentDayIdx<state.days.length-1)switchDay(currentDayIdx+1);
    else if(dx>0&&currentDayIdx>0)switchDay(currentDayIdx-1);
    else if(dx>0&&currentDayIdx===0)switchDay(-1);
  },{passive:true});
  const SWIPE_KEY='seasons_swipe_v1';
  if(!localStorage.getItem(SWIPE_KEY)){
    localStorage.setItem(SWIPE_KEY,'1');
    setTimeout(()=>{
      const p=document.querySelector('.day-panel.active');
      if(p){p.classList.add('swipe-hint-anim');setTimeout(()=>p.classList.remove('swipe-hint-anim'),800);}
    },1200);
  }
})();

/* --- Travel Departure Alerts --- */
let _alertTimers=[];

function _travelAlertMins(a,b,mode){
  if(!a?.lat||!a?.lng||!b?.lat||!b?.lng)return 0;
  return _travelMins(haversine(a.lat,a.lng,b.lat,b.lng),mode);
}

async function enableTravelAlerts(dayIdx){
  const day=state.days[dayIdx];
  if(!day||!day.stops.length){showToast('No stops to alert for');return;}
  if(!('Notification' in window)){showToast('Notifications not supported on this browser');return;}

  let perm=Notification.permission;
  if(perm==='default')perm=await Notification.requestPermission();
  if(perm!=='granted'){showToast('Allow notifications in browser settings to use travel alerts');return;}

  // Only works for today
  const dpStr=(day.subtitle||'').split(/\s*[·•]\s*/)[0].trim();
  const dayDate=_parseTripDate(dpStr);
  const today=new Date();today.setHours(0,0,0,0);
  if(dayDate)dayDate.setHours(0,0,0,0);
  if(!dayDate||dayDate.getTime()!==today.getTime()){
    showToast('Travel alerts work for today\'s day only');return;
  }

  // Cancel any previously scheduled alerts
  _alertTimers.forEach(clearTimeout);_alertTimers=[];

  const now=new Date();
  const stops=day.stops.filter(s=>!s.alt);
  let scheduled=0;

  for(let si=1;si<stops.length;si++){
    const curr=stops[si],prev=stops[si-1];
    if(!curr.time)continue;
    const arrMins=_parseTimeMins(curr.time);
    if(arrMins===null)continue;

    const rawMode=prev.transitMode||_defaultTransitMode(prev,curr);
    const mode=rawMode;
    const travelMins=_travelAlertMins(prev,curr,mode);
    // Alert 10 min before you need to leave (so departure = arrMins - travelMins - 10)
    const fireAt=new Date(today);
    fireAt.setMinutes(arrMins-travelMins-10);
    const delay=fireAt-now;
    if(delay<0)continue;  // already past

    const leg=legLabel(prev,curr,mode);
    const icon=TM_ICON[mode]||'🚗';
    const body=leg?leg+' · '+(TM_LABEL[mode]||'Drive'):(TM_LABEL[mode]||'Drive')+' ahead';

    const t=setTimeout(async()=>{
      try{
        const reg=await navigator.serviceWorker.ready;
        reg.showNotification(icon+' Leave for '+curr.name,{
          body,
          icon:'/Travel/icon-192.png',
          badge:'/Travel/icon-192.png',
          tag:'depart-'+dayIdx+'-'+si,
          data:{url:'trip.html?id='+tripId},
          vibrate:[200,100,200]
        });
      }catch(e){
        if(Notification.permission==='granted')
          new Notification(icon+' Leave for '+curr.name,{body,icon:'/Travel/icon-192.png'});
      }
    },delay);
    _alertTimers.push(t);
    scheduled++;
  }

  if(!scheduled){showToast('No upcoming timed stops to alert for');return;}
  showToast('&#128276; '+scheduled+' departure alert'+(scheduled>1?'s':'')+' set for today — keep this tab open');
  const btn=document.getElementById('alerts-btn-'+dayIdx);
  if(btn){btn.style.background='var(--ruby)';btn.style.color='white';btn.innerHTML='&#128276; Alerts On';}
}

/* --- Read-Only Mode --- */
if(IS_READONLY){
  const bar=document.getElementById('readonly-bar');
  if(bar)bar.classList.add('on');
  const s=document.createElement('style');
  s.textContent='.add-stop-btn,.card-btn,.tab-remove,.tab-move,.tab-add,.lodge-next-btn,.day-narr-refresh,.stop-desc-btn,.stop-desc-regen,.pack-gen-btn,.add-check-row,.dl-btn,.ai-action-btn,.plan-chat-float,.tour-guide-float,.alt-btn,.opt-apply-btn,.opt-fix-btn{display:none!important}#modal-overlay,#copy-modal,#travelers-modal,#ai-optimizer-modal,#ai-grader-modal,#plan-chat-modal{display:none!important}';
  document.head.appendChild(s);
}

/* ===== END FEATURE EXTENSIONS ===== */

function _moveDayTo(from,to){
  if(from===to||from<0||to<0||from>=state.days.length||to>=state.days.length)return;
  const [d]=state.days.splice(from,1);
  state.days.splice(to,0,d);
  _wxDayCache={}; // day indices changed — invalidate the index-keyed weather cache
  if(currentDayIdx===from)currentDayIdx=to;
  else if(from<to&&currentDayIdx>from&&currentDayIdx<=to)currentDayIdx--;
  else if(from>to&&currentDayIdx>=to&&currentDayIdx<from)currentDayIdx++;
  saveState('Reordered days');renderAll();
}
function _setupTabDrag(){
  const bar=document.getElementById('tabs-inner');if(!bar||bar._dnd)return;bar._dnd=true;
  bar.addEventListener('dragstart',e=>{
    const it=e.target.closest('[data-day-idx]');if(!it)return;
    _dragDayFrom=parseInt(it.dataset.dayIdx);
    setTimeout(()=>it.classList.add('dragging'),0);
    e.dataTransfer.effectAllowed='move';
    e.dataTransfer.setData('text/plain',String(_dragDayFrom));
  });
  bar.addEventListener('dragover',e=>{
    const it=e.target.closest('[data-day-idx]');
    if(!it||parseInt(it.dataset.dayIdx)===_dragDayFrom)return;
    e.preventDefault();
    bar.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
    it.classList.add('drag-over');
  });
  bar.addEventListener('dragleave',e=>{
    if(!bar.contains(e.relatedTarget))bar.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
  });
  bar.addEventListener('dragend',()=>{
    bar.querySelectorAll('.dragging,.drag-over').forEach(el=>el.classList.remove('dragging','drag-over'));
    _dragDayFrom=-1;
  });
  bar.addEventListener('drop',e=>{
    e.preventDefault();
    const it=e.target.closest('[data-day-idx]');
    const to=it?parseInt(it.dataset.dayIdx):-1;
    bar.querySelectorAll('.dragging,.drag-over').forEach(el=>el.classList.remove('dragging','drag-over'));
    if(_dragDayFrom>=0&&to>=0&&_dragDayFrom!==to)_moveDayTo(_dragDayFrom,to);
    _dragDayFrom=-1;
  });
}

/* ============================================================
   FEATURE 2: Offline Mode
   ============================================================ */
function _updateOfflineState(){
  const offline=!navigator.onLine;
  document.body.classList.toggle('offline',offline);
  const banner=document.getElementById('offline-banner');
  if(banner)banner.style.display=offline?'':'none';
}
window.addEventListener('online',_updateOfflineState);
window.addEventListener('offline',_updateOfflineState);

/* ============================================================
   FEATURE 3: Pre-Generated Guidebook Content
   ============================================================ */
const GUIDEBOOK_SYSTEM='You are a knowledgeable travel writer creating rich stop descriptions for a travel guidebook. Write 2-3 paragraphs covering: the history and cultural significance, what visitors typically skip that is worth seeing, ticket and entry tips, realistic time needed, and the best photo spot. Be specific and practical. Use plain prose with no markdown headers, no bullet points, no em dashes. Respond with only the guidebook text.';
const NEARBY_SYSTEM='You are a local expert writing a brief 2-3 sentence note for travelers about what else is worth knowing in the immediate area around a day\'s stops. Focus on hidden gems, practical tips, or context that makes the day richer. No em dashes. Respond with only the note text.';

// Guidebook expand/collapse is a per-VIEW UI state — kept OUT of the trip state so
// it never syncs to the cloud and flips another person's view. Keyed by stable id.
let _gbOpen={};
function _guidebookHtml(s,di,si){
  if(['drive','flight','train','bus'].includes(s.type))return'';
  if(!s.guidebook)return'';
  const isOpen=!!_gbOpen[s._sid];
  return'<button class="guidebook-btn" onclick="toggleGuidebook('+di+','+si+')">&#128366; Guidebook '+(isOpen?'&#9650;':'&#9660;')+'</button>'+
    '<div class="guidebook-content" id="gb-'+di+'-'+si+'" style="display:'+(isOpen?'block':'none')+'">'+_escHtml(s.guidebook)+'</div>';
}

function toggleGuidebook(di,si){
  const s=state.days[di]?.stops[si];if(!s||!s.guidebook)return;
  _gbOpen[s._sid]=!_gbOpen[s._sid];
  const btn=document.querySelector('#stop-card-'+di+'-'+si+' .guidebook-btn');
  const content=document.getElementById('gb-'+di+'-'+si);
  if(content)content.style.display=_gbOpen[s._sid]?'block':'none';
  if(btn)btn.innerHTML='&#128366; Guidebook '+(_gbOpen[s._sid]?'&#9650;':'&#9660;');
}

async function generateGuidebook(regenerate){
  const allStops=[];
  state.days.forEach((d,di)=>{
    d.stops.forEach((s,si)=>{
      if(['drive','flight','train','bus'].includes(s.type))return;
      if(s.guidebook&&!regenerate)return;
      allStops.push({di,si});
    });
  });
  if(!allStops.length){
    alert('All stops already have guidebook entries. Call generateGuidebook(true) to regenerate.');
    return;
  }
  let progressEl=document.getElementById('gen-progress');
  if(!progressEl){
    progressEl=document.createElement('div');
    progressEl.id='gen-progress';progressEl.className='gen-progress';
    document.body.appendChild(progressEl);
  }
  let done=0;
  for(const {di,si} of allStops){
    const s=state.days[di]?.stops[si];if(!s)continue;
    done++;
    progressEl.textContent='Generating '+done+' of '+allStops.length+': '+s.name+'...';
    try{
      const prompt='Stop: '+s.name+(s.notes?'\nNotes: '+s.notes:'')+(s.lat&&s.lng?'\nCoordinates: '+Number(s.lat).toFixed(4)+','+Number(s.lng).toFixed(4):'');
      const text=await callClaude(GUIDEBOOK_SYSTEM,prompt);
      state.days[di].stops[si].guidebook=text.trim();
    }catch(e){console.warn('Guidebook generation failed for '+s.name,e);}
  }
  progressEl.textContent='Generating nearby notes...';
  for(let di=0;di<state.days.length;di++){
    const d=state.days[di];
    const eligible=d.stops.filter(s=>!['drive','flight','train','bus'].includes(s.type));
    if(eligible.length<1)continue;
    try{
      const stopList=eligible.map(s=>s.name).join(', ');
      const text=await callClaude(NEARBY_SYSTEM,'Day: '+d.title+'\nStops: '+stopList);
      d.nearby=text.trim();
    }catch(e){console.warn('Nearby note failed for day '+di,e);}
  }
  progressEl.textContent='';
  saveState('Generated guidebook');
  renderAll();
}

/* ============================================================
   FEATURE 4: Location-Aware AI Tour Guide
   ============================================================ */
const TG_SYSTEM='You are a knowledgeable local tour guide who knows this area intimately. You provide warm, conversational, and practical guidance. You know history, culture, food, hidden gems, and practical visitor tips. Respond in 2-4 sentences. Be specific to the exact place. No em dashes.';
let _tgHistory=[];
let _tgCurrentStop=null;

function openTourGuide(){
  const modal=document.getElementById('tour-guide-modal');if(!modal)return;
  const content=document.getElementById('tg-content');if(!content)return;
  _tgHistory=[];_tgCurrentStop=null;
  content.innerHTML='<div class="tg-thinking">Finding your location...</div>';
  modal.classList.add('open');
  if(!navigator.geolocation){_setupTourGuideStopPicker();return;}
  navigator.geolocation.getCurrentPosition(
    pos=>_setupTourGuideWithPosition(pos.coords.latitude,pos.coords.longitude),
    ()=>_setupTourGuideStopPicker(),
    {timeout:6000}
  );
}

function _setupTourGuideWithPosition(lat,lng){
  let nearest=null,nearestDist=Infinity,nearestDi=-1,nearestSi=-1;
  state.days.forEach((d,di)=>{
    d.stops.forEach((s,si)=>{
      if(!s.lat||!s.lng||['drive','flight','train','bus'].includes(s.type))return;
      const dist=haversine(lat,lng,parseFloat(s.lat),parseFloat(s.lng));
      if(dist<nearestDist){nearestDist=dist;nearest=s;nearestDi=di;nearestSi=si;}
    });
  });
  if(nearest)_setupTourGuideWithStop(nearestDi,nearestSi,lat,lng);
  else _setupTourGuideStopPicker();
}

function _setupTourGuideWithStop(di,si,userLat,userLng){
  const s=state.days[di]?.stops[si];if(!s)return;
  _tgCurrentStop={di,si,s};
  const now=new Date();
  const timeStr=now.getHours()+':'+(now.getMinutes()<10?'0':'')+now.getMinutes();
  const dayStops=(state.days[di]?.stops||[]).map(x=>x.name).join(', ');
  const seedMsg='You are guiding someone at or near: '+s.name+'.\nTime: '+timeStr+
    (userLat?'\nUser coordinates: '+Number(userLat).toFixed(4)+','+Number(userLng).toFixed(4):'')+
    "\nToday's stops: "+dayStops+
    (s.guidebook?'\n\nGuidebook context:\n'+s.guidebook:'');
  _tgHistory=[{role:'user',content:seedMsg},{role:'assistant',content:"I'm here with you at "+s.name+". What would you like to know?"}];
  const chips=['Tell me about this place',"What should I not miss here?",'Where\'s good for lunch nearby?'];
  const content=document.getElementById('tg-content');if(!content)return;
  content.innerHTML=
    '<div class="tg-messages" id="tg-messages">'+
    '<div class="tg-msg tg-msg-ai">I\'m here with you at <strong>'+_escHtml(s.name)+'</strong>. What would you like to know?</div>'+
    '</div>'+
    '<div class="tg-chips" id="tg-chips">'+
    chips.map(c=>'<button class="tg-chip" onclick="_tgChip(this,'+JSON.stringify(c)+')">'+_escHtml(c)+'</button>').join('')+
    '</div>'+
    '<div class="tg-input-row">'+
    '<input class="tg-input" id="tg-input" placeholder="Ask me anything..." onkeydown="if(event.key===\'Enter\')_tgSendMessage()"/>'+
    '<button class="tg-send" onclick="_tgSendMessage()">&#10148;</button>'+
    '</div>';
}

function _setupTourGuideStopPicker(){
  const stops=[];
  state.days.forEach((d,di)=>{
    d.stops.forEach((s,si)=>{
      if(!['drive','flight','train','bus'].includes(s.type))stops.push({di,si,name:s.name,day:d.title});
    });
  });
  const content=document.getElementById('tg-content');if(!content)return;
  content.innerHTML='<div class="tg-thinking" style="margin-bottom:12px">Choose a stop to get guided:</div>'+
    '<select class="tg-stop-select" id="tg-stop-sel">'+
    stops.map(({di,si,name,day})=>'<option value="'+di+'-'+si+'">'+_escHtml(name)+' ('+_escHtml(day)+')</option>').join('')+
    '</select>'+
    '<button class="tg-send" style="width:100%;margin-top:8px;border-radius:8px;padding:10px" onclick="_tgPickStop()">Start Tour Guide</button>';
}

function _tgPickStop(){
  const sel=document.getElementById('tg-stop-sel');if(!sel)return;
  const [di,si]=sel.value.split('-').map(Number);
  _setupTourGuideWithStop(di,si,null,null);
}

function _tgChip(btn,text){
  const chips=document.getElementById('tg-chips');
  if(chips)chips.style.display='none';
  _tgAddMessage('user',text);
  _tgCallAI(text);
}

async function _tgSendMessage(){
  const input=document.getElementById('tg-input');if(!input)return;
  const text=input.value.trim();if(!text)return;
  input.value='';
  _tgAddMessage('user',text);
  _tgCallAI(text);
}

async function _tgCallAI(userText){
  const msgs=document.getElementById('tg-messages');
  const thinking=document.createElement('div');
  thinking.className='tg-msg tg-thinking';thinking.textContent='Thinking...';
  if(msgs){msgs.appendChild(thinking);msgs.scrollTop=msgs.scrollHeight;}
  _tgHistory.push({role:'user',content:userText});
  try{
    const convo=_tgHistory.map(m=>m.role+': '+m.content).join('\n\n');
    const text=await callClaude(TG_SYSTEM,convo);
    if(thinking.parentNode)thinking.parentNode.removeChild(thinking);
    _tgHistory.push({role:'assistant',content:text});
    _tgAddMessage('assistant',text);
  }catch(e){
    if(thinking.parentNode)thinking.parentNode.removeChild(thinking);
    _tgAddMessage('error','Could not reach the AI. Please try again.');
  }
}

function _tgAddMessage(role,text){
  const msgs=document.getElementById('tg-messages');if(!msgs)return;
  const div=document.createElement('div');
  div.className='tg-msg '+(role==='user'?'tg-msg-user':role==='error'?'tg-msg-err':'tg-msg-ai');
  div.textContent=text;
  msgs.appendChild(div);
  msgs.scrollTop=msgs.scrollHeight;
}

function _updateTourGuideFloat(){
  const btn=document.getElementById('tour-guide-float');if(!btn)return;
  const todayIdx=_getTodayDayIdx();
  // Show on every screen size, not just phones — the big screen (iPad) was
  // hiding it purely because of the old window.innerWidth<=768 restriction.
  btn.style.display=(todayIdx>=0)?'flex':'none';
}

/* ============================================================
   FEATURE 5: Unbooked Digest
   ============================================================ */
function renderUnbookedSection(){
  if(!state?.days)return'';
  const RESERVATION_NEEDED=['lodge','flight','train','bus'];
  const PREBOOK_RE=/pre-?book|book in advance|book now|sells out|timed entry|timed slot/i;
  const rows=[];
  state.days.forEach((d,di)=>{
    const dateStr=(d.subtitle||'').split(/\s*[·•]\s*/)[0].trim();
    const dayDate=dateStr?(_parseTripDate(dateStr)||new Date(dateStr+' 12:00')):null; // correct year for countdown
    const daysUntil=(dayDate&&!isNaN(dayDate))?Math.ceil((dayDate-new Date())/86400000):null;
    d.stops.forEach((s,si)=>{
      if(s.reservation)return;
      const needsBook=RESERVATION_NEEDED.includes(s.type)||PREBOOK_RE.test(s.notes||'');
      if(!needsBook)return;
      rows.push({name:s.name,type:s.type,date:dateStr,daysUntil,di,si});
    });
  });
  const badge=rows.length?'<span class="ov-badge">'+rows.length+'</span>':'';
  const inner=rows.length
    ?rows.map(r=>{
        const dc=r.daysUntil!==null?(r.daysUntil<14?'days-urgent':r.daysUntil<45?'days-warn':'days-ok'):'days-ok';
        const db=r.daysUntil!==null?'<span class="days-badge '+dc+'">'+r.daysUntil+'d</span>':'';
        return'<div class="unbooked-row" onclick="jumpToStop('+r.di+','+r.si+')" style="cursor:pointer">'+
          '<span class="unbooked-name">'+_escHtml(r.name)+'</span>'+
          '<span class="unbooked-date">'+_escHtml(r.date||'')+'</span>'+
          db+'</div>';
      }).join('')
    :'<div class="unbooked-all-clear">&#10003; All bookings confirmed</div>';
  return'<div class="ov-section" style="margin-top:16px">'+
    '<div style="font-family:var(--font-ui);font-weight:600;font-size:14px;margin-bottom:10px;color:var(--ink)">&#128197; Still Unbooked '+badge+'</div>'+
    inner+'</div>';
}

function jumpToStop(di,si){
  switchDay(di);
  setTimeout(()=>{
    const el=document.getElementById('stop-card-'+di+'-'+si);
    if(el)el.scrollIntoView({behavior:'smooth',block:'center'});
  },300);
}

/* ============================================================
   FEATURE 6: Live Mode
   ============================================================ */
function _updateLivePill(){
  const pill=document.getElementById('live-pill');if(!pill)return;
  pill.style.display=_getTodayDayIdx()>=0?'inline-flex':'none';
}

async function loadLiveWeather(dayIdx){
  const strip=document.getElementById('live-wx-'+dayIdx);if(!strip)return;
  const day=state.days[dayIdx];if(!day)return;
  let lat=null,lng=null;
  for(const s of day.stops){if(s.lat&&s.lng){lat=parseFloat(s.lat);lng=parseFloat(s.lng);break;}}
  if(lat===null){strip.style.display='none';return;}
  strip.innerHTML='<span style="font-family:var(--font-ui);font-size:11px;color:var(--muted);padding:6px 8px">Loading weather...</span>';
  try{
    const url='https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lng+
      '&hourly=temperature_2m,weathercode&temperature_unit=fahrenheit&forecast_days=1&timezone=auto';
    const r=await fetch(url);if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();
    const hours=data.hourly?.time||[];
    const temps=data.hourly?.temperature_2m||[];
    const codes=data.hourly?.weathercode||[];
    const nowH=(new Date()).getHours();
    const items=[];
    for(let i=0;i<hours.length&&items.length<3;i++){
      const h=parseInt(hours[i].slice(11,13));
      if(h>=nowH)items.push({time:hours[i].slice(11,16),temp:Math.round(temps[i]),code:codes[i]});
    }
    if(!items.length){strip.style.display='none';return;}
    const _wxIcon=code=>{
      if(code===0)return'☀️';if(code<=2)return'⛅';if(code<=3)return'☁️';
      if(code<=49)return'🌫️';if(code<=59)return'🌦️';if(code<=69)return'🌧️';
      if(code<=79)return'🌨️';if(code<=82)return'🌧️';if(code<=86)return'❄️';
      if(code<=99)return'⛈️';return'🌡️';
    };
    strip.innerHTML=items.map(it=>
      '<div class="live-wx-item">'+
      '<div class="live-wx-time">'+it.time+'</div>'+
      '<div class="live-wx-icon">'+_wxIcon(it.code)+'</div>'+
      '<div class="live-wx-temp">'+it.temp+'°F</div>'+
      '</div>'
    ).join('');
  }catch(e){strip.style.display='none';}
}

/* ============================================================
   FEATURE 7: Booking Deep Links
   ============================================================ */
function _bookingLinkHtml(s){
  if(['drive','flight','train','bus'].includes(s.type))return'';
  if(s.reservation)return'';
  let label,searchQuery;
  if(s.type==='lodge'){
    label='&#127968; Book';
    searchQuery=encodeURIComponent(s.name+' hotel booking');
  }else if(s.type==='food'){
    label='&#127374; Reserve';
    searchQuery=encodeURIComponent(s.name+' restaurant reservation');
  }else{
    label='&#127981; Tickets & Info';
    searchQuery=encodeURIComponent(s.name+' tickets');
  }
  const href=_safeUrl(s.url)||('https://www.google.com/search?q='+searchQuery);
  return'<a class="map-link" href="'+_escHtml(href)+'" target="_blank" rel="noopener">'+label+'</a>';
}

/* ============================================================
   FEATURE 8: Proposed Cross-Day Moves
   ============================================================ */
function _applyProposedMove(move){
  const{stop_name,from_day,to_day}=move;
  const fromIdx=(from_day||0)-1,toIdx=(to_day||0)-1;
  if(fromIdx<0||toIdx<0||fromIdx>=state.days.length||toIdx>=state.days.length)return false;
  const _k=(stop_name||'').toLowerCase().trim();if(!_k)return false; // empty name would match the first stop
  const si=state.days[fromIdx].stops.findIndex(s=>s.name.toLowerCase().includes(_k.slice(0,20)));
  if(si<0)return false;
  const [moved]=state.days[fromIdx].stops.splice(si,1);
  state.days[toIdx].stops.push(moved);
  return true;
}

function applyProposedMove(moveIdx){
  if(!_optLastData?.proposed_moves?.[moveIdx])return;
  const move=_optLastData.proposed_moves[moveIdx];
  const snapshot=JSON.parse(JSON.stringify(state.days));
  if(_applyProposedMove(move)){
    saveState('Applied proposed move');
    document.getElementById('ai-optimizer-modal').classList.remove('open');
    renderAll();
    showUndoBanner('Moved "'+_escHtml(move.stop_name||'')+'" to Day '+move.to_day,()=>{
      state.days=snapshot;saveState('Undid move');renderAll();
    });
  }
}

function applyAllProposedMoves(){
  if(!_optLastData?.proposed_moves?.length)return;
  const snapshot=JSON.parse(JSON.stringify(state.days));
  let applied=0;
  for(const move of _optLastData.proposed_moves){if(_applyProposedMove(move))applied++;}
  if(applied>0){
    saveState('Applied all proposed moves');
    document.getElementById('ai-optimizer-modal').classList.remove('open');
    renderAll();
    showUndoBanner('Applied '+applied+' proposed move'+(applied>1?'s':''),()=>{
      state.days=snapshot;saveState('Undid moves');renderAll();
    });
  }
}

/* ============================================================
   FEATURE 9: Trip Recap / Memory View
   ============================================================ */
function openTripRecap(){
  const modal=document.getElementById('trip-recap-modal');if(!modal)return;
  const content=document.getElementById('trip-recap-content');if(!content)return;
  content.innerHTML=_renderRecap();
  modal.classList.add('open');
}

function _renderRecap(){
  const startIso=dayDateStr(0);
  const endIso=dayDateStr(state.days.length-1);
  let h='<div class="recap-hero">'+
    '<div class="recap-trip-name">'+_escHtml(state.title||'Trip Recap')+'</div>'+
    (startIso&&endIso?'<div class="recap-dates">'+startIso+' &ndash; '+endIso+'</div>':'')+
    '</div>';
  state.days.forEach((d,di)=>{
    const dayNote=jnlData[_jnlDayKey(di)]||'';
    h+='<div class="recap-day-hdr">'+_escHtml(d.title)+
      (d.subtitle?'<span style="font-weight:400;font-size:13px;margin-left:8px;color:var(--muted)">'+_escHtml(d.subtitle)+'</span>':'')+
      '</div>';
    if(dayNote)h+='<div class="recap-day-jnl">'+_escHtml(dayNote)+'</div>';
    d.stops.forEach((s,si)=>{
      const note=jnlData[_jnlNoteKey(di,si)]||'';
      const rating=parseInt(jnlData[_jnlRatingKey(di,si)]||0);
      const hasContent=note||rating||s.customImage;
      if(!hasContent){
        h+='<div class="recap-compact">'+_escHtml(s.name)+'</div>';
        return;
      }
      h+='<div class="recap-memory-card">'+
        (_safeImgSrc(s.customImage)?'<img class="recap-photo" src="'+_escHtml(_safeImgSrc(s.customImage))+'" alt="'+_escHtml(s.name)+'" loading="lazy"/>':'')+
        '<div class="recap-card-body">'+
        '<div class="recap-stop-name">'+_escHtml(s.name)+'</div>'+
        (rating?'<div class="recap-stars-row">'+Array(rating).fill('&#9733;').join('')+'</div>':'')+
        (note?'<div class="recap-note">'+_escHtml(note)+'</div>':'')+
        '</div></div>';
    });
  });
  h+='<div style="text-align:center;padding:16px 16px 32px">'+
    '<button class="recap-share-btn" onclick="shareRecap()">&#128279; Share Recap</button>'+
    '</div>';
  return h;
}

function shareRecap(){
  document.getElementById('trip-recap-modal')?.classList.remove('open');
  openShareModal();
}

/* ============================================================
   PLANNING CHAT — Ask AI about your trip
   ============================================================ */
const PLAN_CHAT_SYSTEM='You are an expert travel planning assistant. You have full knowledge of the user\'s itinerary and answer questions about logistics, timing, attractions, restaurants, transportation, and trip improvements. Be specific, practical, and concise. No em dashes.';

let _pcHistory=[];

function _buildTripContext(){
  if(!state?.days?.length)return'Trip has no days yet.';
  let ctx='Trip: '+(state.title||'Untitled')+'\n';
  const startIso=dayDateStr(0);
  if(startIso)ctx+='Start date: '+startIso+'\n';
  ctx+='\n';
  state.days.forEach((d,di)=>{
    ctx+='Day '+(di+1)+': '+d.title+(d.subtitle?' ('+d.subtitle+')':'')+'\n';
    d.stops.forEach((s,si)=>{
      ctx+='  '+(si+1)+'. '+s.name+' ['+s.type+']';
      if(s.time)ctx+=' @'+s.time;
      if(s.duration)ctx+=' ('+s.duration+')';
      if(s.notes)ctx+=' -- '+s.notes;
      ctx+='\n';
    });
  });
  return ctx;
}

function openPlanChat(){
  const modal=document.getElementById('plan-chat-modal');if(!modal)return;
  const content=document.getElementById('pc-content');if(!content)return;
  // Only reset history if reopening a fresh session
  if(!_pcHistory.length){
    // Do NOT seed the full itinerary here — the AI receives it once via _itinMap()
    // appended to the system prompt on every call. Seeding it again duplicated a
    // large payload on long trips and could make the request fail.
    _pcHistory=[{role:'user',content:'I have questions about my trip. My full itinerary is provided to you separately as the LIVE ITINERARY.'},
      {role:'assistant',content:'I have your full itinerary. What would you like to know about your trip?'}];
  }
  const chips=['Is my pacing realistic?','What am I missing?','Any booking deadlines I should know?'];
  content.innerHTML=
    '<div class="plan-ctx">&#9432; AI has your full '+state.days.length+'-day itinerary as context.</div>'+
    '<div class="tg-messages" id="pc-messages">'+
    '<div class="tg-msg tg-msg-ai">I have your full itinerary. What would you like to know about your trip?</div>'+
    '</div>'+
    '<div class="tg-chips" id="pc-chips">'+
    chips.map(c=>'<button class="tg-chip" onclick="_pcChip(this,'+JSON.stringify(c)+')">'+_escHtml(c)+'</button>').join('')+
    '</div>'+
    '<div class="tg-input-row">'+
    '<input class="tg-input" id="pc-input" placeholder="Ask anything about your trip..." onkeydown="if(event.key===\'Enter\')_planSendMessage()"/>'+
    '<button class="tg-send" onclick="_planSendMessage()">&#10148;</button>'+
    '</div>';
  modal.classList.add('open');
  setTimeout(()=>document.getElementById('pc-input')?.focus(),120);
}

function _pcChip(btn,text){
  document.getElementById('pc-chips')?.remove();
  _pcAddMessage('user',text);
  _planCallAI(text);
}

function _planSendMessage(){
  const input=document.getElementById('pc-input');if(!input)return;
  const text=input.value.trim();if(!text)return;
  input.value='';
  _pcAddMessage('user',text);
  _planCallAI(text);
}

async function _planCallAI(userText){
  const msgs=document.getElementById('pc-messages');
  const thinking=document.createElement('div');
  thinking.className='tg-msg tg-thinking';thinking.textContent='Thinking...';
  if(msgs){msgs.appendChild(thinking);msgs.scrollTop=msgs.scrollHeight;}
  _pcHistory.push({role:'user',content:userText});
  try{
    const convo=_pcHistory.map(m=>m.role+': '+m.content).join('\n\n');
    // Include the itinerary map here too (the conversation no longer seeds it).
    const sys=PLAN_CHAT_SYSTEM+(typeof _itinMap==='function'?_itinMap():'');
    const text=await callClaude(sys,convo);
    if(thinking.parentNode)thinking.parentNode.removeChild(thinking);
    _pcHistory.push({role:'assistant',content:text});
    _pcAddMessage('assistant',text);
  }catch(e){
    if(thinking.parentNode)thinking.parentNode.removeChild(thinking);
    const why=(e&&e.message)?String(e.message):'could not reach the server';
    _pcAddMessage('error','AI request failed: '+why+'. Please try again.');
  }
}

function _pcAddMessage(role,text){
  const msgs=document.getElementById('pc-messages');if(!msgs)return;
  const div=document.createElement('div');
  div.className='tg-msg '+(role==='user'?'tg-msg-user':role==='error'?'tg-msg-err':'tg-msg-ai');
  div.textContent=text;
  msgs.appendChild(div);
  msgs.scrollTop=msgs.scrollHeight;
}

// Read a trip's offline-saved state: localStorage first, then the Cache API
// fallback used for itineraries too large for localStorage.
async function _readSavedState(){
  const s=localStorage.getItem(LS_KEY);
  if(s){try{return JSON.parse(s);}catch(e){}}
  if('caches' in window){
    try{
      const r=await caches.match('/Travel/offline-state/'+encodeURIComponent(tripId)+'.json');
      if(r){return await r.json();}
    }catch(e){}
  }
  return null;
}
async function init(){
  // RECOVERY (?recover=1): rescue UI that reads this device's saved copy and can
  // push a good copy to everyone. MUST be the very first thing — before any cloud
  // read or the family watcher — so it can never overwrite this device's copy.
  if(new URLSearchParams(location.search).get('recover')==='1'){
    try{ await _recoveryScreen(); }
    catch(e){ document.body.innerHTML='<pre style="padding:16px;white-space:pre-wrap">Recovery screen error: '+((e&&e.message)||e)+'</pre>'; }
    return;
  }
  const localTrips=JSON.parse(localStorage.getItem('localTrips')||'[]');
  const isLocal=localTrips.some(t=>t.id===tripId);
  const _famParam=new URLSearchParams(location.search).get('fam')==='1';
  if(_famParam)localStorage.setItem('tripFamily_'+tripId,'1');
  // Explicit, one-time restore escape hatch (?restore=savedplan). Runs before we
  // read the (possibly-corrupt) cloud copy so the user can force the saved plan
  // back. Confirm-gated inside _restoreSavedPlan; on OK it reloads and returns.
  if(new URLSearchParams(location.search).get('restore')==='savedplan'){
    try{ await _restoreSavedPlan(); }catch(e){ alert('Restore failed: '+(e&&e.message||e)); }
    return;
  }
  const isFamilyOverride=localStorage.getItem('tripFamily_'+tripId)==='1';
  const isFamily=isFamilyOverride||_famParam||(BUILT_IN.includes(tripId)&&!localTrips.some(t=>t.id===tripId&&localStorage.getItem('tripFamily_'+tripId)==='0'));

  if(isFamily){
    const savedState=await _readSavedState();
    let haveLocal=false;
    if(savedState){ state=savedState; haveLocal=true; }
    if(haveLocal){
      // Fast path: render the cached copy now; refresh from the cloud in the
      // background and re-render only if it actually changed.
      (async()=>{
        try{
          const raw=await fetch(_familyBase()+'.json?nc='+Date.now(),{cache:'no-store'});
          const data=await raw.json();
          if(data&&_validTripState(data.state)){
            _lastFamilyAt=(data.lastChange&&data.lastChange.at)||0;
            if(JSON.stringify(data.state)!==JSON.stringify(state)){
              state=data.state; if(!state.tripType)state.tripType='family';
              try{ _sortAllDaysByTime(); }catch(e){}
              try{ _seedLogicBaseline(); }catch(e){}   // adopted cloud state is the new baseline
              // NO auto-mutation here. Adopting a cloud copy must never rewrite it and
              // push back — that auto-heal-on-load pattern is what corrupted the trip.
              try{localStorage.setItem(LS_KEY,JSON.stringify(state))}catch(e){}
              renderAll();
            }
          }
        }catch(e){}
      })();
    }else{
      // No cached copy — must fetch before the first render.
      try{
        const raw=await fetch(_familyBase()+'.json?nc='+Date.now(),{cache:'no-store'});
        const data=await raw.json();
        if(data&&_validTripState(data.state)){
          state=data.state;
          _lastFamilyAt=(data.lastChange&&data.lastChange.at)||0;
          try{localStorage.setItem(LS_KEY,JSON.stringify(state))}catch(e){}
        }else{
          // The cloud looked empty or unreadable. This may just be a momentary bad
          // read — so we show the built-in trip as a starting point but NEVER write
          // it to the shared cloud. (Writing the default here is exactly what wiped
          // a month of edits.) If the cloud really has data, the 3-second watcher
          // will pick it up on the next poll; if it's genuinely new, the first real
          // edit seeds the cloud safely through the guarded sync.
          const r=await fetch('trips/'+tripId+'.json');state=await r.json();
          state.tripType='family';
        }
      }catch(e){
        try{const r=await fetch('trips/'+tripId+'.json');state=await r.json();}
        catch(e2){state={days:[],title:'Trip'};}
      }
    }
    if(!state.tripType)state.tripType='family';
    _startFamily();
  }else{
    const savedState=await _readSavedState();
    if(savedState){state=savedState;}
    else{
      try{const r=await fetch('trips/'+tripId+'.json');state=await r.json();}
      catch(e){state={days:[],title:'Trip'};}
    }
    if(!state.tripType)state.tripType='solo';
  }

  try{ _healLoadedItinerary(); }catch(e){}   // ONCE at load, never on every render
  try{ _seedLogicBaseline(); }catch(e){}   // baseline = the itinerary as loaded (gate blocks only NEW impossibilities)
  // NO auto-mutation of the itinerary on load. Nothing here may rewrite stops/days
  // and save — that on-load auto-heal pattern is what overwrote real data.
  try{ if(_ensureJnlIds())saveState('',true); _migrateJnlKeys(); }catch(e){}
  if(state.title)document.title='Seasons — '+state.title;
  if(state.mapCenter)map.setView(state.mapCenter,state.mapZoom||8);
  currentDayIdx=-1;
  const _autoToday=_getTodayDayIdx();
  if(_autoToday>=0)currentDayIdx=_autoToday;
  /* one-time migration: move stop_desc_v1 cache into stop.desc */
  try{
    const old=JSON.parse(localStorage.getItem('stop_desc_v1')||'{}');
    if(Object.keys(old).length){
      let changed=false;
      state.days.forEach(d=>d.stops.forEach(s=>{
        if(s.desc)return;
        const k=s.name.toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,44);
        if(old[k]){s.desc=old[k];changed=true;}
      }));
      if(changed){saveState('',true);localStorage.removeItem('stop_desc_v1');}
    }
  }catch(e){}
  /* apply pending import from index.html (stored in sessionStorage to survive Firebase reload) */
  try{
    const pending=sessionStorage.getItem('pendingImport_'+tripId);
    if(pending){
      sessionStorage.removeItem('pendingImport_'+tripId);
      const parsedDays=JSON.parse(pending);
      const _isoFromSub=sub=>{if(!sub)return'';const p=sub.split(/\s*[·•]\s*/)[0].trim();const d=new Date(p+' 12:00');return isNaN(d)?'':_localISO(d);};
      const _insertChron=(stops,st)=>{
        const t=_parseTimeMins(st.time);
        if(t===null){stops.push(st);return;}
        const idx=stops.findIndex(s=>{const m=_parseTimeMins(s.time);return m!==null&&m>t;});
        idx===-1?stops.push(st):stops.splice(idx,0,st);
      };
      let added=0;
      parsedDays.forEach(pd=>{
        (pd.stops||[]).forEach(st=>{
          const stDate=st.date||_isoFromSub(pd.subtitle);
          delete st.date;
          const match=stDate?state.days.find(ed=>_isoFromSub(ed.subtitle)===stDate):null;
          if(match){_insertChron(match.stops,st);added++;}
          else{
            let bucket=state.days.find(ed=>ed.title===pd.title);
            if(!bucket){bucket={title:pd.title,subtitle:pd.subtitle||'',tip:'',stops:[]};state.days.push(bucket);}
            _insertChron(bucket.stops,st);added++;
          }
        });
      });
      if(added>0)saveState('Imported '+added+' stop'+(added>1?'s':''));
    }
  }catch(e){}
  renderAll();loadTimezones();_setupTabDrag();
  _updateTypeBadge();
  if(isJournalMode()){const b=document.getElementById('journal-mode-banner');if(b)b.classList.add('on');}
  document.getElementById('ai-grader-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('ai-optimizer-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('share-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('travelers-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('alternates-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('tour-guide-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('trip-recap-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('plan-chat-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  // Escape closes whatever modal/overlay is currently open.
  document.addEventListener('keydown',function(e){
    if(e.key!=='Escape')return;
    let closed=false;
    document.querySelectorAll('.modal-overlay.open, #modal-overlay.open, #copy-modal.open').forEach(m=>{m.classList.remove('open');closed=true;});
    if(!closed && typeof closeTicketViewer==='function'){try{closeTicketViewer();}catch(_){}}
  });
  _updateLivePill();
  _updateTourGuideFloat();
  _updateOfflineState();
  window.addEventListener('resize',_updateTourGuideFloat);
  new ResizeObserver(updateTabScrollBtns).observe(document.getElementById('tabs-inner'));
  new ResizeObserver(updateTabsTop).observe(document.querySelector('header'));
  updateTabsTop();
  const imported=sessionStorage.getItem('justImported');
  if(imported){
    sessionStorage.removeItem('justImported');
    const b=document.getElementById('import-banner');
    b.innerHTML='✓ "'+_escHtml(imported)+'" was added to your trips. You can now edit it independently.';
    b.classList.add('visible');
    setTimeout(()=>b.classList.remove('visible'),6000);
  }
}
init();
if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js');}