const tripId=new URLSearchParams(location.search).get('id')||'utah';
const LS_KEY='tripState_'+tripId;
const PACK_KEY='seasons_packing_'+tripId;
const PROXY_URL='https://travel-ai-proxy.sps047.workers.dev';
function lsPack(val){
  if(val===undefined){try{return JSON.parse(localStorage.getItem(PACK_KEY)||'null')}catch(e){return null}}
  try{localStorage.setItem(PACK_KEY,JSON.stringify(val))}catch(e){}
}
/* ---- Firebase config (Family trip sync) ---- */
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
function saveState(changeDesc=''){
  try{localStorage.setItem(LS_KEY,JSON.stringify(state))}catch(e){}
  if(getTripType()==='family')_syncFamily(changeDesc);
}

const map=L.map('map',{zoomControl:true,center:[39,-98],zoom:4});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',maxZoom:19}).addTo(map);
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
  const dataUrl=await new Promise(resolve=>{
    const reader=new FileReader();
    reader.onload=e=>{
      const img=new Image();
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
  if(mode==='walk')return Math.round(straightLineMiles/0.05);
  // drive: apply 1.25 road-overhead factor then adaptive mph
  const road=straightLineMiles*1.25;
  const mph=road>120?65:road>40?55:road>10?40:20;
  return Math.round(road/mph*60);
}
function _minsToStr(mins){
  return mins<60?mins+' min':(Math.floor(mins/60)+'h'+(mins%60?' '+(mins%60)+'min':''));
}
function legLabel(a,b,mode){
  if(!a.lat||!a.lng||!b.lat||!b.lng)return'';
  const dist=haversine(a.lat,a.lng,b.lat,b.lng);
  if(dist<0.05)return'';
  const mi=dist<10?dist.toFixed(1):Math.round(dist);
  const mins=_travelMins(dist,mode);
  return mi+' mi · '+_minsToStr(mins);
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

async function fetchRoute(stops){
  const rs=stops.filter((s,i)=>{
    if(s.alt||!s.lat||!s.lng||s.type==='flight')return false;
    return true;
  });
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

async function renderDayMap(idx){
  markersLayer.clearLayers();routeLayer.clearLayers();
  const day=state.days[idx];if(!day)return;
  const st=document.getElementById('route-status');
  st.style.display='block';st.textContent='Loading driving routes...';
  const bounds=[];
  day.stops.forEach((s,i)=>{
    if(!s.lat||!s.lng)return;
    const m=L.marker([s.lat,s.lng],{icon:makeIcon(i+1,TC[s.type]||'#8B7355',s.alt)});
    m.bindPopup('<div style="font-weight:700;font-size:13px">'+s.name+'</div>'+(s.alt?'<div style="font-size:11px;color:#5555BB;margin-top:3px">Alternate option</div>':''),{maxWidth:200});
    markersLayer.addLayer(m);bounds.push([s.lat,s.lng]);
  });
  if(bounds.length)map.fitBounds(bounds,{padding:[40,40]});
  for(let i=0;i<day.stops.length-1;i++){
    const a=day.stops[i],b=day.stops[i+1];
    if(a.type==='flight'&&a.lat&&b.lat){
      L.polyline(greatCirclePoints([a.lat,a.lng],[b.lat,b.lng]),{color:'#4A7EC7',weight:2.5,opacity:0.8,dashArray:'8,5'}).addTo(routeLayer);
    }
  }
  try{
    const rc=await fetchRoute(day.stops);
    if(rc){L.polyline(rc.map(c=>[c[1],c[0]]),{color:'#C1512D',weight:3.5,opacity:0.75}).addTo(routeLayer);st.style.display='none';}
    else{
      const ml=day.stops.filter(s=>!s.alt&&s.lat&&s.type!=='flight').map(s=>[s.lat,s.lng]);
      if(ml.length>1)L.polyline(ml,{color:'#C1512D',weight:2.5,opacity:0.5,dashArray:'6,6'}).addTo(routeLayer);
      st.textContent='Showing approximate route';setTimeout(()=>{st.style.display='none'},3000);
    }
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
    item.innerHTML='<button class="tab-move" onclick="moveDay('+i+',-1)" '+(i===0?'disabled':'')+'>&#8592;</button><button class="tab-btn" onclick="switchDay('+i+')">Day '+(i+1)+'</button><button class="tab-move" onclick="moveDay('+i+',1)" '+(i===state.days.length-1?'disabled':'')+'>&#8594;</button><button class="tab-remove" onclick="removeDay('+i+')" title="Remove day">&times;</button>';
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

function dayDateStr(dayIdx){
  const day=state.days[dayIdx];if(!day)return'';
  const sub=day.subtitle||'';
  const datePart=sub.split(/\s*[·•]\s*/)[0].trim();
  if(!datePart)return'';
  const d=new Date(datePart+' 12:00');
  if(isNaN(d.getTime()))return'';
  return d.toISOString().slice(0,10);
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
    const hadDate=parts[0]&&!isNaN(new Date(parts[0].trim()+' 12:00').getTime());
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

function getHotelForDay(dayIdx){
  for(let i=Math.min(dayIdx,state.days.length-1);i>=0;i--){
    const lodge=state.days[i].stops.find(s=>s.type==='lodge'&&!/^depart\b/i.test(s.name));
    if(lodge)return lodge;
  }
  return null;
}
function getNextHotelForDay(dayIdx){
  for(let i=dayIdx;i<state.days.length;i++){
    const lodge=state.days[i].stops.find(s=>s.type==='lodge'&&!/^depart\b/i.test(s.name));
    if(lodge)return lodge;
  }
  return null;
}
function hotelBookendHtml(label,lodge,otherStop){
  const nm=lodge.name.replace(/^check.?in\s*[—–\-]\s*/i,'').replace(/\s*[—–].*/,'').trim();
  let travelHtml='';
  if(otherStop&&lodge.lat&&lodge.lng&&otherStop.lat&&otherStop.lng){
    const dist=haversine(lodge.lat,lodge.lng,otherStop.lat,otherStop.lng);
    const mi=dist<10?dist.toFixed(1):Math.round(dist);
    const tStr=_minsToStr(_travelMins(dist,'drive'));
    const isStart=label.toLowerCase().startsWith('start');
    const [oLat,oLng,dLat,dLng]=isStart?[lodge.lat,lodge.lng,otherStop.lat,otherStop.lng]:[otherStop.lat,otherStop.lng,lodge.lat,lodge.lng];
    const mapsUrl='https://www.google.com/maps/dir/?api=1&origin='+oLat+','+oLng+'&destination='+dLat+','+dLng+'&travelmode=driving';
    travelHtml='<div class="hotel-bookend-travel"><span class="hotel-bookend-dist">'+mi+' mi · '+tStr+' drive</span><a class="map-link" href="'+mapsUrl+'" target="_blank" rel="noopener"><svg width="9" height="11" viewBox="0 0 30 36" fill="currentColor" style="flex-shrink:0"><path d="M15 0C7.268 0 1 6.268 1 14c0 8.836 14 22 14 22S29 22.836 29 14C29 6.268 22.732 0 15 0z"/></svg> Directions</a></div>';
  }
  return'<div class="hotel-bookend"><span class="hotel-bookend-icon">&#127970;</span><div style="flex:1"><div class="hotel-bookend-label">'+label+'</div><div class="hotel-bookend-name">'+nm+'</div>'+travelHtml+'</div></div>';
}

function transitBookendHtml(transitStop,firstStop){
  const ICONS={flight:'&#9992;',train:'&#128642;',bus:'&#128652;'};
  const LABELS={flight:'In flight',train:'On train',bus:'On bus'};
  const icon=ICONS[transitStop.type]||'&#128652;';
  const label=LABELS[transitStop.type]||'In transit';
  const arrTime=firstStop&&firstStop.time?(' &middot; arriving '+firstStop.time):'';
  const nm=transitStop.name.replace(/^check.?in\s*[—–\-]\s*/i,'').trim();
  return'<div class="hotel-bookend"><span class="hotel-bookend-icon">'+icon+'</span><div style="flex:1"><div class="hotel-bookend-label">'+label+arrTime+'</div><div class="hotel-bookend-name">'+nm+'</div></div></div>';
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
  const conflicts=detectConflicts(idx);
  const jnlMode=isJournalMode();
  const wxCache=_wxDayCache[idx]||null;
  const WX_OUTDOOR=['hike','drive'];
  let cards=prevEndsInTransit&&day.stops.length>0?transitBookendHtml(prevLastStop,day.stops[0]):
    showStart?hotelBookendHtml('Starting from',prevHotel,day.stops[0]):'';
  day.stops.forEach((s,si)=>{
    const isFirst=si===0,isLast=si===day.stops.length-1;
    const _tr=['flight','train','bus'].includes(s.type)?parsedTransitRoute(s):null;
    cards+='<div class="stop-card'+(s.alt?' alt-stop':'')+'" style="animation-delay:'+si*40+'ms">'+
      '<div class="stop-dot dot-'+(s.type||'drive')+'">'+(si+1)+'</div>'+
      '<div class="card-controls" ontouchstart="event.stopPropagation()">'+
      '<button class="card-btn" onclick="moveStop('+idx+','+si+',-1)" title="Move up" '+(isFirst?'disabled':'')+'>&#9650;</button>'+
      '<button class="card-btn edit-btn" onclick="openEditStopModal('+idx+','+si+')" title="Edit stop">&#9998;</button>'+
      '<button class="card-btn" onclick="deleteStop('+idx+','+si+')" title="Remove" style="font-size:16px">&times;</button>'+
      '<button class="card-btn" onclick="moveStop('+idx+','+si+',1)" title="Move down" '+(isLast?'disabled':'')+'>&#9660;</button>'+
      '<button class="card-btn" onclick="openCopyModal('+idx+','+si+')" title="Copy to another day" style="font-size:11px">&#8599;</button>'+
      '</div>'+
      '<div class="card-top">'+(s.time?'<span class="card-time">'+s.time+(stopTz(s)?'<span class="card-tz">'+stopTz(s).abbr+'</span>':'')+' </span>':'')+'<div class="card-main">'+
      '<div class="card-name">'+s.name+(s.alt?' <span style="font-weight:400;font-size:12px">(alternate)</span>':'')+(conflicts[si]?'<span class="conflict-badge" tabindex="0">&#9888;<span class="ctip">'+conflicts[si].join('<br>')+'</span></span>':'')+(WX_OUTDOOR.includes(s.type)?_wxWarnHtml(wxCache):'')+(s.recentlyChanged?'<span class="recently-changed-dot" title="Recently changed by AI"></span>':'')+'</div>'+
      (_tr?'<div class="card-notes" style="font-size:12px;font-weight:600;margin-top:3px">'+_tr.from+' → '+_tr.to+'</div>':'')+
      (s.stars?'<div class="card-stars">&#9733; '+s.stars+'</div>':'')+
      (s.notes?'<div class="card-notes">'+s.notes+'</div>':'')+
      (s.reservation?'<div class="card-notes" style="margin-top:4px;font-size:11.5px;font-weight:600;color:var(--pine);letter-spacing:0.03em">&#128203; Conf&nbsp;#&nbsp;'+s.reservation+'</div>':'')+
      '</div></div><div class="badges">'+badge(s.type)+(s.alt?'<span class="badge badge-alt">Alternate</span>':'')+(s.reservation?'<span class="badge badge-booked">&#10003; Booked</span>':(['lodge','flight','train','bus'].includes(s.type)||/pre-?book|book in advance|book now|sells out|timed entry|timed slot/i.test(s.notes||''))&&!/^depart\b/i.test(s.name)?'<span class="badge badge-tobook">&#128197; To Book</span>':'')+'</div>'+
      _audioBadgeHtml(s)+
      (s.ticketImage?'<button class="ticket-view-btn" onclick="showTicketViewer('+idx+','+si+')">&#127903; View Ticket</button>':'')+
      (s.lat&&s.lng?'<a class="map-link" href="https://www.google.com/maps/search/?api=1&query='+s.lat+','+s.lng+'" target="_blank" rel="noopener"><svg width="9" height="11" viewBox="0 0 30 36" fill="currentColor" style="flex-shrink:0"><path d="M15 0C7.268 0 1 6.268 1 14c0 8.836 14 22 14 22S29 22.836 29 14C29 6.268 22.732 0 15 0z"/></svg> Directions</a>':'')+
      (s.type==='flight'?flightAwareLink(s.name,s.notes,s.flightNumber)+''+_checkinLink(s.flightNumber,s.airline):'')+
      (s.type==='lodge'&&isLast&&idx<state.days.length-1?'<button class="lodge-next-btn" onclick="openCopyModal('+idx+','+si+')">&#8594; Copy to start of Day '+(idx+2)+'</button>':'')+
      '<div class="stop-img-wrap" id="stopimg-'+idx+'-'+si+'" style="position:relative"></div>'+
      (!['drive','flight','train','bus'].includes(s.type)?'<div class="stopdesc-wrap" id="stopdesc-'+idx+'-'+si+'">'+(s.desc?'<div class="stop-desc"><span class="stop-desc-text">'+s.desc+'</span><button class="stop-desc-regen" onclick="refreshStopDesc('+idx+','+si+')" title="Regenerate">&#8635;</button></div>':'<button class="stop-desc-btn" onclick="generateStopDesc('+idx+','+si+')">&#10024; Describe</button>')+'</div>':'')+
      (s.type==='food'?'<button class="alt-btn" onclick="showAlternates('+idx+','+si+')">&#128260; Alternates</button>':'')+
      _stopPlaceMetaHtml(s)+
      _attendanceHtml(s)+
      (jnlMode?_jnlStopHtml(idx,si):'')+
      '</div>';
    if(!isLast){
      const next=day.stops[si+1];
      const rawMode=s.transitMode||_defaultTransitMode(s,next);
      const tmode=rawMode==='subway'?'train':rawMode;
      const leg=legLabel(s,next,tmode);
      const tzc=tzChangeLabel(s,next);
      const modePill='<span class="leg-mode-pill '+(TM_CLS[tmode]||TM_CLS.drive)+'">'+(TM_ICON[tmode]||'🚗')+' '+(TM_LABEL[tmode]||'Drive')+'</span>';
      if(leg||tzc){
        cards+='<div class="leg-connector"><span class="leg-connector-arrow">&#8595;</span>'+(leg||'')+modePill+
          (tzc?'<span class="tz-change" style="margin-left:'+(leg?'10px':'0')+'">&#9201; '+tzc+'</span>':'')+
          '</div>';
      }else{
        cards+='<div class="leg-connector"><span class="leg-connector-arrow">&#8595;</span>'+modePill+'</div>';
      }
    }
  });
  const panelCls='day-panel'+(idx===currentDayIdx?' active':'');
  return'<div class="'+panelCls+'" id="panel-'+idx+'">'+
    '<div class="day-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">'+
    '<div><h2>'+day.title+'</h2>'+(day.subtitle?'<p>'+_fmtSubtitle(day.subtitle)+'</p>':'')+'</div>'+
    '<div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap;margin-top:2px">'+
    '<button class="ai-action-btn" onclick="optimizeDay('+idx+')">&#10024; Optimize Day</button>'+
    '<button class="ai-action-btn" id="alerts-btn-'+idx+'" onclick="enableTravelAlerts('+idx+')" title="Schedule departure reminders for each stop">&#128276; Alerts</button>'+
    '</div>'+
    '</div>'+
    (jnlMode?_jnlDayHtml(idx):'')+
    renderDaySummary(day,idx)+
    (day.stops.length>0?'<div class="day-narr" id="day-narr-'+idx+'"><div class="day-narr-label">&#127918; Today\'s Briefing<button class="day-narr-refresh" onclick="refreshDayNarrative('+idx+')">&#8635; Refresh</button></div><div class="day-narr-body narr-loading" id="day-narr-body-'+idx+'">Preparing your day briefing…</div></div>':'')+
    '<div class="timeline">'+cards+(showEnd?hotelBookendHtml('Tonight',todayHotel,day.stops[day.stops.length-1]):'')+
    '<button class="add-stop-btn" onclick="openAddStopModal('+idx+')">'+
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="4.5" x2="8" y2="11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="4.5" y1="8" x2="11.5" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Add Stop</button></div>'+
    (day.tip?'<div class="pro-tip"><div class="pro-tip-label">Pro Tip — Day '+(idx+1)+'</div><p>'+day.tip+'</p></div>':'')+
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

async function loadStopImages(){
  const allStops=state.days.flatMap((d,di)=>d.stops.map((s,si)=>({stop:s,di,si})));
  for(const {stop,di,si} of allStops){
    const el=document.getElementById('stopimg-'+di+'-'+si);
    if(!el||el.classList.contains('loaded'))continue;
    if(stop.customImage){
      el.innerHTML='<img class="stop-img" src="'+stop.customImage+'" alt="'+stop.name+'" loading="lazy"/>';
      el.classList.add('loaded');continue;
    }
    const url=await fetchStopImage(stop.name);
    if(url&&!el.classList.contains('loaded')){
      el.innerHTML='<img class="stop-img" src="'+url+'" alt="'+stop.name+'" loading="lazy"/><span class="stop-img-credit">&#169; Wikipedia / CC</span>';
      el.classList.add('loaded');
    }
  }
}

/* ---- Day narrative (AI) ---- */
const NARR_LS='day_narr_v1';
let narrData={};
try{narrData=JSON.parse(localStorage.getItem(NARR_LS)||'{}')}catch(e){}

const WX_ICONS={0:'☀️',1:'🌤️',2:'🌤️',3:'☁️',45:'🌫️',48:'🌫️',51:'🌦️',53:'🌦️',55:'🌧️',61:'🌦️',63:'🌧️',65:'🌧️',71:'🌨️',73:'❄️',75:'❄️',80:'🌦️',81:'🌧️',82:'⛈️',85:'🌨️',86:'❄️',95:'⛈️',96:'⛈️',99:'⛈️'};
const WX_LABELS={0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Foggy',48:'Freezing fog',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',80:'Rain showers',81:'Showers',82:'Heavy showers',85:'Snow showers',86:'Snow showers',95:'Thunderstorm',96:'Thunderstorm',99:'Thunderstorm'};
/* Parse "Sun Jun 7", "Jun 7", "June 7, 2026", etc. — infers year from closest to today */
function _parseTripDate(str){
  if(!str)return null;
  // For strings with explicit 4-digit year, parse directly
  if(/\b\d{4}\b/.test(str)){
    const d=new Date(str+' 12:00:00');
    if(!isNaN(d.getTime())&&d.getFullYear()>=2020&&d.getFullYear()<=2040)return d;
  }
  // No explicit year: extract month+day and infer year closest to today
  // (avoids V8's quirky behavior parsing "Sun Jun 7" which picks wrong past years)
  const m=str.match(/([A-Za-z]{3,9})\s+(\d{1,2})/);
  if(!m)return null;
  const now=new Date();now.setHours(12,0,0,0);
  let best=null,bestGap=Infinity;
  for(const yr of[now.getFullYear()-1,now.getFullYear(),now.getFullYear()+1]){
    const c=new Date(m[1]+' '+m[2]+', '+yr+' 12:00:00');
    if(isNaN(c.getTime())||c.getFullYear()<2020)continue;
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
  if(diffDays>16)return{tooFarOut:true,wxType:'climateAvg',month:date.toLocaleString('en-US',{month:'long'}),lat:coords.lat,lng:coords.lng};
  const ds=date.toISOString().slice(0,10);
  if(diffDays<0){
    try{
      const r=await fetch('https://archive-api.open-meteo.com/v1/archive?latitude='+coords.lat+'&longitude='+coords.lng+'&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto&temperature_unit=fahrenheit&start_date='+ds+'&end_date='+ds);
      if(!r.ok)return null;
      const d=await r.json();
      if(!d.daily?.temperature_2m_max?.length)return null;
      const precip=d.daily.precipitation_sum[0];
      return{hi:Math.round(d.daily.temperature_2m_max[0]),lo:Math.round(d.daily.temperature_2m_min[0]),precip:precip!=null?Math.round(precip*10)/10:null,precipUnit:'mm',code:d.daily.weathercode[0],wxType:'historical',tooFarOut:false};
    }catch(e){return null;}
  }
  try{
    const r=await fetch('https://api.open-meteo.com/v1/forecast?latitude='+coords.lat+'&longitude='+coords.lng+'&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=auto&temperature_unit=fahrenheit&start_date='+ds+'&end_date='+ds);
    if(!r.ok)return null;
    const d=await r.json();
    if(!d.daily?.temperature_2m_max?.length)return null;
    return{hi:Math.round(d.daily.temperature_2m_max[0]),lo:Math.round(d.daily.temperature_2m_min[0]),precip:d.daily.precipitation_probability_max[0],code:d.daily.weathercode[0],wxType:'forecast',tooFarOut:false};
  }catch(e){return null;}
}

const NARR_SYSTEM='You are a charismatic tour guide delivering the morning briefing to your group over breakfast. Format your response in exactly two parts separated by a single newline: (1) A weather line starting with a weather emoji, e.g. "☀️ Clear sky · High 82°F / Low 58°F · Climate Avg". End the weather line with the label "Climate Avg". Estimate typical weather for this location and time of year. (2) Two to three flowing, engaging sentences about what the group will experience today, written in second person. Specific, evocative, exciting. Pure prose — no bullets, no headers.';
const NARR_PROSE_SYSTEM='You are a charismatic tour guide delivering the morning briefing over breakfast. Write exactly 2-3 flowing, engaging sentences about what the group will experience today. Second person, specific, evocative, exciting. Pure prose only — no weather line (weather is shown separately), no bullets, no headers.';

function _escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
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
      if(diff>=-5&&diff<=16)dateTag='|'+new Date().toISOString().slice(0,10);
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
    const fresh=document.getElementById('day-narr-body-'+dayIdx);
    if(fresh){const box=fresh.closest('.day-narr');if(box)box.style.display='none';}
  }
}

function refreshDayNarrative(dayIdx){
  const key=dayNarrKey(dayIdx);
  if(key)delete narrData[key];
  try{localStorage.setItem(NARR_LS,JSON.stringify(narrData))}catch(e){}
  loadDayNarrative(dayIdx);
}

function promptGoogleKey(){
  const key=prompt('Enter your Google Places API key (stored in trip settings):');
  if(key&&key.trim()){
    if(!state.settings)state.settings={};
    state.settings.googlePlacesKey=key.trim();
    saveState('Set Google Places key');
    showToast('Google Places key saved');
  }
}

/* ---- Stop descriptions (AI) ---- */
const DESC_SYSTEM='You are a travel guidebook author writing in the style of Fodor\'s or Rick Steves. Write exactly 2-3 sentences about this location: what it is, why it matters, and what a visitor should look for. Be specific and evocative, not generic. Do not begin with the place name. Do not use markdown or bullet points.';

function _renderDesc(wrap,text,dayIdx,stopIdx){
  wrap.innerHTML='<div class="stop-desc"><span class="stop-desc-text">'+text+'</span><button class="stop-desc-regen" onclick="refreshStopDesc('+dayIdx+','+stopIdx+')" title="Regenerate">&#8635;</button></div>';
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
  try{renderTabs();}catch(e){console.error('[renderTabs]',e);}
  try{
    if(currentDayIdx===-1){
      document.getElementById('content-area').innerHTML=renderOverview();
    }else{
      document.getElementById('content-area').innerHTML=state.days.map((_,i)=>renderPanel(i)).join('');
      loadStopImages();
      if(currentDayIdx>=0)loadDayNarrative(currentDayIdx);
    }
  }catch(e){
    console.error('[renderAll]',e);
    const ca=document.getElementById('content-area');
    if(ca)ca.innerHTML='<div style="padding:32px;font-family:var(--font-ui);color:var(--ruby)">⚠️ Render error: '+_escHtml(e.message)+'<br><small style="color:var(--muted)">Check browser console for details.</small></div>';
  }
}

function switchDay(idx){
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
  if(currentDayIdx>=state.days.length)currentDayIdx=state.days.length-1;
  saveState();renderAll();renderDayMap(currentDayIdx);
}

function moveDay(idx,dir){
  const ni=idx+dir;
  if(ni<0||ni>=state.days.length)return;
  [state.days[idx],state.days[ni]]=[state.days[ni],state.days[idx]];
  if(currentDayIdx===idx)currentDayIdx=ni;
  else if(currentDayIdx===ni)currentDayIdx=idx;
  saveState();renderAll();renderDayMap(currentDayIdx);
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
  if(atStart)state.days[toDayIdx].stops.unshift(stop);
  else state.days[toDayIdx].stops.push(stop);
  saveState();closeCopyModal();renderAll();renderDayMap(currentDayIdx);
}

function _parseTimeMins(t){
  if(!t)return null;
  const m=t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if(!m)return null;
  let h=parseInt(m[1]),mn=parseInt(m[2]);
  const ap=(m[3]||'').toLowerCase();
  if(ap==='pm'&&h!==12)h+=12;
  else if(ap==='am'&&h===12)h=0;
  return h*60+mn;
}
function _formatTimeMins(mins){
  mins=((mins%1440)+1440)%1440;
  const h=Math.floor(mins/60),m=mins%60;
  const hh=h%12||12,ampm=h<12?'am':'pm';
  return hh+':'+(m<10?'0':'')+m+ampm;
}
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
function moveStop(dayIdx,stopIdx,dir){
  const stops=state.days[dayIdx].stops;
  const newIdx=stopIdx+dir;
  if(newIdx<0||newIdx>=stops.length)return;
  [stops[stopIdx],stops[newIdx]]=[stops[newIdx],stops[stopIdx]];
  const suggested=_suggestStopTime(stops,newIdx);
  if(suggested)stops[newIdx].time=suggested;
  saveState();renderAll();if(dayIdx===currentDayIdx)renderDayMap(currentDayIdx);
}

function deleteStop(dayIdx,stopIdx){
  if(!confirm('Remove "'+state.days[dayIdx].stops[stopIdx].name+'"?'))return;
  state.days[dayIdx].stops.splice(stopIdx,1);
  saveState();renderAll();if(dayIdx===currentDayIdx)renderDayMap(currentDayIdx);
}

function setModalMode(isEdit){
  document.querySelector('#modal-overlay .modal-title').textContent=isEdit?'Edit Stop':'Add a Stop';
  document.querySelector('#modal-overlay .btn-primary').textContent=isEdit?'Save Changes':'Add Stop';
}
function openAddStopModal(dayIdx){
  editingStop=null;addingToDay=dayIdx;
  ['place-search','f-name','f-date','f-time','f-stars','f-lat','f-lng','f-notes','f-reservation','f-from','f-to','f-airline','f-flightnum'].forEach(id=>{document.getElementById(id).value=''});
  document.getElementById('f-date').value=dayDateStr(dayIdx);
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
  document.getElementById('f-time').value=s.time||'';
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
  if(q.length<3){document.getElementById('search-results').classList.remove('open');return}
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
      return'<div class="search-result-item" onclick="pickResult('+i+')"><div class="result-name">'+name+'</div><div class="result-addr">'+addr+'</div></div>';
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
  if(isNaN(lat)||isNaN(lng)){alert('Please select a search result or enter valid coordinates.');return}
  if(Math.abs(lat)>90&&Math.abs(lng)<=90){[lat,lng]=[lng,lat];}
  if(Math.abs(lat)>90||Math.abs(lng)>180){alert('Coordinates appear invalid. Lat must be -90 to 90, Lng must be -180 to 180.');return}
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
  const stop={name,lat,lng,type:stopType,time:document.getElementById('f-time').value.trim(),stars:document.getElementById('f-stars').value.trim()||null,notes:document.getElementById('f-notes').value.trim(),reservation:document.getElementById('f-reservation').value.trim()||null,from:document.getElementById('f-from').value.trim()||null,to:document.getElementById('f-to').value.trim()||null,airline:stopType==='flight'?(document.getElementById('f-airline').value.trim()||null):null,flightNumber:stopType==='flight'?(document.getElementById('f-flightnum').value.trim()||null):null,alt:document.getElementById('f-alt').checked,customImage,ticketImage:ticketImage||undefined,ticketFileName:ticketFileName||undefined,transitMode:transitMode||undefined,attendance:attendance};
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
  else{renderAll();if(srcDayIdx===currentDayIdx||destDayIdx===currentDayIdx)renderDayMap(currentDayIdx);}
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
    if(btn){btn.disabled=false;btn.textContent='&#10024; Find Audio Tours with AI';}
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
  const d=new Date(str+' 12:00');
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
      '<div class="cal-theme">'+theme+'</div>'+
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
      '<div class="lodge-info"><div class="lodge-name">'+nm+(s.reservation?'<span class="badge-booked-sm">&#10003; Booked</span>':'')+'</div>'+(s.notes?'<div class="lodge-notes">'+s.notes+'</div>':'')+'</div>'+
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
    (totalBook?'<div class="checklist-count">'+bookedCount+' of '+totalBook+' bookings confirmed</div>':'')+
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
    (state.settings?.googlePlacesKey?'':'<div style="font-family:var(--font-ui);font-size:12px;color:var(--muted);padding:10px 14px;background:var(--mist);border-radius:var(--radius-md);border:1px dashed var(--border);margin-top:12px">&#128269; <strong>Tip:</strong> Add a <a href="#" onclick="promptGoogleKey();return false" style="color:var(--river)">Google Places API key</a> in settings to auto-populate opening hours and websites for stops.</div>')+
    '</div>';
  const panelAudio='<div class="ov-tab-panel" id="ovtab-audio"'+(activeOvTab!=='audio'?' style="display:none"':'')+'>'+
    renderAudioToursHtml()+'</div>';

  const startIso=dayDateStr(0);
  const startDateHtml='<div class="ov-start-date">&#128197; Starts: '+
    '<input type="date" id="ov-start-input" value="'+startIso+'" onchange="setTripStartDate(this.value)"'+(isJournalMode()?' disabled':'')+'/>'+
    (startIso?'':'<span style="color:var(--muted);font-size:12px"> (pick a date to set day dates)</span>')+
    '</div>';

  return'<div class="ov-panel">'+
    '<div class="ov-section">'+
    (state.title?'<div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">'+
    '<div class="ov-trip-name" style="margin-bottom:0">'+state.title+'</div>'+
    '<div style="display:flex;gap:8px;flex-shrink:0;align-items:center">'+
    '<button class="ai-action-btn" onclick="gradeItinerary()">&#10024; Grade</button>'+
    '<button class="ai-action-btn" onclick="openShareModal()" style="background:var(--pine)">&#128279; Share</button>'+
    '<button class="ai-action-btn" onclick="openTravelersModal()" style="background:var(--slate,#4A6572)">&#128100; Travelers</button>'+
    '</div></div>':'')
    +startDateHtml+statsHtml+budgetHtml+'</div>'+
    (jnl?_tripHighlightsHtml():'')+
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

function toggleCheckItem(id,done){
  const item=(state.checklist||[]).find(i=>i.id===id);
  if(item){item.done=done;saveState();}
  const el=document.getElementById('chk-'+id);
  if(el){el.classList.toggle('done',done);const cb=el.querySelector('input[type=checkbox]');if(cb)cb.checked=done;}
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
  /* preserve type prefix for auto items */
  const prefixM=item.text.replace(/^⚠️\s*/,'').match(/^(Hotel|Flight|Train|Book):/);
  const prefix=prefixM?prefixM[1]+': ':'';
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
        '<span class="pack-name">'+cat.emoji+' '+cat.name+'</span>'+
        '<span class="pack-count">'+catChecked+'/'+cat.items.length+' <span class="pack-toggle" id="pack-tog-'+ci+'">&#9660;</span></span>'+
        '</div>'+
        '<div class="pack-items open" id="pack-cat-'+ci+'">'+
        cat.items.map((item,ii)=>{
          const key=ci+'-'+ii;
          const isChecked=!!checked[key];
          return'<label class="pack-item'+(isChecked?' checked':'')+'">'+
            '<input type="checkbox" '+(isChecked?'checked':'')+' onchange="togglePackItem(\''+key+'\',this.checked)"/>'+
            '<span class="pack-item-text">'+item+'</span>'+
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

async function renderOverviewMap(){
  markersLayer.clearLayers();routeLayer.clearLayers();
  const bounds=[];
  state.days.forEach((day,di)=>{
    day.stops.forEach((s,si)=>{
      if(!s.lat||!s.lng)return;
      const m=L.marker([s.lat,s.lng],{icon:makeIcon(di+1,TC[s.type]||'#8B7355',s.alt)});
      m.bindPopup('<div style="font-weight:700;font-size:13px">Day '+(di+1)+': '+s.name+'</div>',{maxWidth:200});
      markersLayer.addLayer(m);bounds.push([s.lat,s.lng]);
    });
  });
  if(bounds.length)map.fitBounds(bounds,{padding:[40,40]});
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

async function _dbFamilyGetAll(){
  const r=await fetch(_familyBase()+'.json?nc='+Date.now(),{cache:'no-store'});
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
    const ts=Date.now();_lastFamilyAt=ts;
    await _dbFamilyPut('/state',JSON.parse(JSON.stringify(state))).catch(()=>{});
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
      const data=await _dbFamilyGetAll();
      if(!data)return;
      const now=Date.now();
      const presence=data.presence||{};
      const active=Object.values(presence).filter(p=>p&&(now-p.at)<90000);
      _updatePresenceCount(active.length);
      const lc=data.lastChange;
      if(lc&&lc.at>_lastFamilyAt&&lc.by!==_sessionId()){
        _lastFamilyAt=lc.at;
        state=data.state;
        try{localStorage.setItem(LS_KEY,JSON.stringify(state))}catch(e){}
        renderAll();
        showToast('✎ Change: '+(lc.desc||'itinerary updated'));
      }
    }catch(e){}
  },3000);
}

function _startFamily(){_watchFamily();_startPresence();}
function _stopFamily(){
  if(_familyPoll){clearInterval(_familyPoll);_familyPoll=null;}
  _stopPresence();
}

function _updatePresenceCount(n){
  const el=document.getElementById('presence-count');
  if(!el)return;
  if(n>1){el.innerHTML='&#128065; '+n+' viewing';el.style.display='inline';}
  else{el.innerHTML='';el.style.display='none';}
}

function _updateTypeBadge(){
  const el=document.getElementById('trip-type-badge');
  if(!el)return;
  const t=getTripType();
  el.innerHTML=t==='family'?'&#127968; Family':'&#128100; Solo';
  el.style.color=t==='family'?'var(--river)':'var(--amber)';
  el.style.background=t==='family'?'var(--river-tint)':'var(--amber-tint)';
  el.style.borderColor=t==='family'?'var(--river-border)':'rgba(196,123,32,0.22)';
}

function toggleTripType(){
  const current=getTripType();
  const next=current==='family'?'solo':'family';
  const msg=next==='family'
    ?'Switch to Family mode? This trip will sync to the cloud and be visible to everyone.'
    :'Switch to Solo mode? This trip will only be saved on this device.';
  if(!confirm(msg))return;
  state.tripType=next;
  if(next==='family'){
    localStorage.setItem('tripFamily_'+tripId,'1');
    _dbFamilyPut('/state',JSON.parse(JSON.stringify(state))).catch(()=>{});
    _dbFamilyPut('/lastChange',{at:Date.now(),by:_sessionId(),desc:'Switched to Family mode'}).catch(()=>{});
    _startFamily();
    showToast('&#127968; Now Family — changes sync to cloud');
  }else{
    localStorage.removeItem('tripFamily_'+tripId);
    _stopFamily();
    showToast('&#128100; Now Solo — saved on this device only');
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

/* ===== FEATURE EXTENSIONS ===== */

/* --- Read-Only Mode --- */
const IS_READONLY=new URLSearchParams(location.search).get('view')==='readonly';

/* --- Transit Mode --- */
let _pendingTransitMode=null;
function setTransitMode(mode){
  _pendingTransitMode=mode;
  document.querySelectorAll('.transit-mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
}
function _defaultTransitMode(a,b){
  if(!a||!b)return'drive';
  if(a.type==='flight'||b.type==='flight')return'flight';
  if(a.type==='train'||b.type==='train')return'train';
  if(a.type==='bus'||b.type==='bus')return'bus';
  if(!a.lat||!a.lng||!b.lat||!b.lng)return'drive';
  return haversine(a.lat,a.lng,b.lat,b.lng)<1?'walk':'drive';
}
const TM_ICON={walk:'🚶',drive:'🚗',train:'🚆',bus:'🚌',flight:'✈️'};
const TM_LABEL={walk:'Walk',drive:'Drive',train:'Train',bus:'Bus',flight:'Flight'};
const TM_CLS={walk:'leg-mode-walk',drive:'leg-mode-drive',train:'leg-mode-train',bus:'leg-mode-bus',flight:'leg-mode-flight'};

/* --- Journal Mode --- */
const JNL_LS='seasons_jnl_'+tripId;
let jnlData={};
try{jnlData=JSON.parse(localStorage.getItem(JNL_LS)||'{}')}catch(e){}
function _saveJnl(){try{localStorage.setItem(JNL_LS,JSON.stringify(jnlData))}catch(e){}}
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
function saveJnlStopNote(di,si,v){jnlData['n_'+di+'_'+si]=v;_saveJnl();}
function saveJnlStopRating(di,si,r){
  jnlData['r_'+di+'_'+si]=r;_saveJnl();
  for(let k=1;k<=5;k++){const el=document.getElementById('js_'+di+'_'+si+'_'+k);if(el)el.classList.toggle('lit',k<=r);}
}
function saveJnlDayEntry(di,v){jnlData['d_'+di]=v;_saveJnl();}
function _jnlStarsHtml(di,si,rat){
  return[1,2,3,4,5].map(k=>'<span class="jstar'+(k<=rat?' lit':'')+'" id="js_'+di+'_'+si+'_'+k+'" onclick="saveJnlStopRating('+di+','+si+','+k+')">&#9733;</span>').join('');
}
function _jnlStopHtml(di,si){
  const note=jnlData['n_'+di+'_'+si]||'';
  const rat=jnlData['r_'+di+'_'+si]||0;
  if(!note&&!rat)return'<div class="journal-section"><button class="jnl-add-btn" onclick="expandJnl(this,'+di+','+si+')">&#9997; Add memory</button></div>';
  return'<div class="journal-section">'+
    '<div class="journal-sec-label">&#9997; Journal</div>'+
    '<textarea class="journal-textarea" placeholder="How was it? Any memories..." oninput="saveJnlStopNote('+di+','+si+',this.value)">'+_escHtml(note)+'</textarea>'+
    '<div class="journal-stars">'+_jnlStarsHtml(di,si,rat)+'<span style="font-family:var(--font-ui);font-size:10px;color:var(--muted);margin-left:7px">Worth it?</span></div>'+
    '</div>';
}
function _jnlDayHtml(di){
  const entry=jnlData['d_'+di]||'';
  if(!entry)return'';
  return'<div class="day-journal-wrap">'+
    '<div class="day-journal-lbl">&#9997; Day '+(di+1)+' Memories</div>'+
    '<textarea class="journal-textarea" style="min-height:85px" placeholder="Overall day memories..." oninput="saveJnlDayEntry('+di+',this.value)">'+_escHtml(entry)+'</textarea>'+
    '</div>';
}
function expandJnl(btn,di,si){
  const note=jnlData['n_'+di+'_'+si]||'';
  const rat=jnlData['r_'+di+'_'+si]||0;
  const sec=btn.closest('.journal-section');
  sec.innerHTML='<div class="journal-sec-label">&#9997; Journal</div>'+
    '<textarea class="journal-textarea" placeholder="How was it? Any memories..." oninput="saveJnlStopNote('+di+','+si+',this.value)">'+_escHtml(note)+'</textarea>'+
    '<div class="journal-stars">'+_jnlStarsHtml(di,si,rat)+'<span style="font-family:var(--font-ui);font-size:10px;color:var(--muted);margin-left:7px">Worth it?</span></div>';
  sec.querySelector('textarea').focus();
}
function _tripHighlightsHtml(){
  const rated=[];
  state.days.forEach((d,di)=>d.stops.forEach((s,si)=>{
    const r=jnlData['r_'+di+'_'+si]||0;
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
  const m=str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if(!m)return null;
  let h=parseInt(m[1]),mn=parseInt(m[2]||0),ap=(m[3]||'').toLowerCase();
  if(ap==='pm'&&h!==12)h+=12;
  if(ap==='am'&&h===12)h=0;
  return h*60+mn;
}
function _dayOfWeek(dayIdx){
  const day=state.days[dayIdx];if(!day)return-1;
  const dp=(day.subtitle||'').split(/\s*[·•]\s*/)[0].trim();
  if(!dp)return-1;
  const d=new Date(dp+' 12:00');
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
    if(s.openingHours&&dow>=0){
      const arr=Array.isArray(s.openingHours)?s.openingHours:Object.values(s.openingHours);
      const todayText=arr[dow]||'';
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
  const key=(state.settings||{}).googlePlacesKey;
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
    saveState('Updated place details: '+stop.name);
    renderAll();if(currentDayIdx>=0)renderDayMap(currentDayIdx);
  }catch(e){}
}
function _stopPlaceMetaHtml(s){
  if(!s.website&&!s.phone&&!s.openingHours)return'';
  let h='<div class="stop-place-meta">';
  if(s.openingHours){
    const arr=Array.isArray(s.openingHours)?s.openingHours:Object.values(s.openingHours);
    const todayTxt=arr[new Date().getDay()]||'';
    if(todayTxt){
      const closed=/closed/i.test(todayTxt);
      const display=todayTxt.replace(/^[^:]*:\s*/,'');
      h+='<span class="'+(closed?'hours-closed':'hours-open')+'">&#128337; '+(closed?'Closed today':display)+'</span>';
    }
  }
  if(s.website)h+=(s.openingHours?' &middot; ':'')+'<a href="'+s.website+'" target="_blank" rel="noopener">&#127760; Website</a>';
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
    let prompt='Trip: '+(state.title||'Unknown')+'\nDays: '+state.days.length+'\n\n';
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
const OPT_SYSTEM='You are an expert travel planner and day optimizer. Score this day across 4 dimensions then suggest improvements.\n\nReturn ONLY valid JSON (no markdown, no code blocks):\n{"optimization_score":78,"score_summary":"one sentence: the single biggest improvement opportunity","sub_scores":{"route":85,"timing":70,"pacing":80,"experience":75},"optimized_order":[{"name":"","rationale":""}],"timing_issues":[{"stop_name":"","issue":"","suggestion":""}],"route_notes":"string"}\n\nScore definitions (each 0-100, their average = optimization_score):\n- route: geographic efficiency — stops in logical order minimizing backtracking\n- timing: alignment with opening hours, avoiding arriving too early/late\n- pacing: realistic time allocation — not too rushed, not too sparse\n- experience: narrative flow — does the day tell a coherent, enjoyable story?\n\nThresholds: 90-100=Near Perfect, 75-89=Well Optimized, 50-74=Good, 0-49=Needs Work.\nBe honest: a day with clear backtracking scores below 60 on route. A tightly clustered day with great flow scores 85+.';
async function optimizeDay(idx){
  const modal=document.getElementById('ai-optimizer-modal');
  const content=document.getElementById('ai-optimizer-content');
  const day=state.days[idx];if(!day)return;
  _optDayIdx=idx;_optLastData=null;
  modal.classList.add('open');
  content.innerHTML='<div class="ai-loading-wrap"><span class="ai-loading-spinner">&#8635;</span><div style="font-family:var(--font-ui);font-size:13px;color:var(--muted)">Optimizing your day…</div></div>';
  try{
    const dp=(day.subtitle||'').split(/\s*[·•]\s*/)[0].trim();
    const dd=dp?new Date(dp+' 12:00'):null;
    const dow=dd&&!isNaN(dd)?['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dd.getDay()]:'';
    let prompt='Day: '+day.title+(dow?'\nDay of week: '+dow:'')+'\nStops:\n';
    day.stops.forEach((s,si)=>{
      prompt+=(si+1)+'. '+s.name+' ['+s.type+']'+(s.time?' @'+s.time:'');
      if(s.lat&&s.lng)prompt+=' ('+Number(s.lat).toFixed(4)+','+Number(s.lng).toFixed(4)+')';
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
  if(s>=90)return'Near Perfect';
  if(s>=75)return'Well Optimized';
  if(s>=50)return'Good';
  return'Needs Work';
}
function _renderOptResult(d){
  _optLastData=d;
  let h='';
  if(d.optimization_score!==undefined){
    const score=Math.max(0,Math.min(100,Math.round(d.optimization_score)));
    const color=_optScoreColor(score);
    const ss=d.sub_scores||{};
    const pills=['route','timing','pacing','experience'].map(k=>{
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
  return h||'<div class="ai-item">No issues found — your day looks well-optimized!</div>';
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
    const si=day.stops.findIndex((s,i)=>!used.has(i)&&s.name.toLowerCase().includes(name.toLowerCase().slice(0,18)));
    if(si>=0){newStops.push(day.stops[si]);used.add(si);}
  });
  day.stops.forEach((s,i)=>{if(!used.has(i))newStops.push(s);});
  day.stops=newStops;
  saveState('Applied optimized order');
  document.getElementById('ai-optimizer-modal').classList.remove('open');
  renderAll();if(currentDayIdx>=0)renderDayMap(currentDayIdx);
  showUndoBanner('Day '+( idx+1)+' stops reordered.',()=>{
    const d=state.days[idx];if(d){d.stops=savedStops;saveState('Undid optimizer changes');renderAll();if(currentDayIdx>=0)renderDayMap(currentDayIdx);}
  });
}
function _sortDayByTime(dayIdx){
  const stops=state.days[dayIdx]?.stops;if(!stops||stops.length<2)return;
  const timed=stops.filter(s=>s.time&&_parseTimeMins(s.time)!==null);
  if(timed.length<2)return;
  stops.sort((a,b)=>{
    const ta=_parseTimeMins(a.time),tb=_parseTimeMins(b.time);
    if(ta===null&&tb===null)return 0;
    if(ta===null)return 1;
    if(tb===null)return -1;
    return ta-tb;
  });
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
  const si=day.stops.findIndex(s=>s.name.toLowerCase().includes((issue.stop_name||'').toLowerCase().slice(0,15)));
  if(si<0)return;
  const suggestedTime=_extractTimeFromText(issue.suggestion);
  if(suggestedTime){
    const savedStop={...day.stops[si]};
    const savedOrder=day.stops.map(s=>({...s}));
    day.stops[si]={...day.stops[si],time:suggestedTime};
    _sortDayByTime(_optDayIdx);
    saveState('Fixed timing issue');
    document.getElementById('ai-optimizer-modal').classList.remove('open');
    renderAll();if(currentDayIdx>=0)renderDayMap(currentDayIdx);
    showUndoBanner('Set "'+_escHtml(issue.stop_name||day.stops[si]?.name||'')+'" → '+suggestedTime,()=>{
      state.days[_optDayIdx].stops=savedOrder;saveState('Undid timing fix');renderAll();if(currentDayIdx>=0)renderDayMap(currentDayIdx);
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
  stop.recentlyChanged=true;
  saveState('Applied restaurant alternate');
  document.getElementById('alternates-modal').classList.remove('open');
  renderAll();if(currentDayIdx>=0)renderDayMap(currentDayIdx);
  showUndoBanner('"'+alt.name+'" applied.',()=>{
    const d=state.days[dayIdx];if(d?.stops?.[stopIdx]){Object.assign(d.stops[stopIdx],origStop);saveState('Undid restaurant alternate');renderAll();if(currentDayIdx>=0)renderDayMap(currentDayIdx);}
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
  renderAll();if(currentDayIdx>=0)renderDayMap(currentDayIdx);
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
    if(dx>dy&&dx>15)e.preventDefault();
  },{passive:false});
  document.addEventListener('touchend',e=>{
    if(!live)return;live=false;
    if(skip(e))return;
    const dx=e.changedTouches[0].clientX-tx,dy=e.changedTouches[0].clientY-ty;
    if(Math.abs(dx)<40||Math.abs(dy)>60)return;
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
    const mode=rawMode==='subway'?'train':rawMode;
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
  if(btn){btn.style.background='var(--ruby)';btn.style.color='white';btn.textContent='&#128276; Alerts On';}
}

/* --- Read-Only Mode --- */
if(IS_READONLY){
  const bar=document.getElementById('readonly-bar');
  if(bar)bar.classList.add('on');
  const s=document.createElement('style');
  s.textContent='.add-stop-btn,.card-btn,.tab-remove,.tab-move,.tab-add,.lodge-next-btn,.day-narr-refresh,.stop-desc-btn,.stop-desc-regen,.pack-gen-btn,.add-check-row,.dl-btn{display:none!important}#modal-overlay,#copy-modal,#travelers-modal{display:none!important}';
  document.head.appendChild(s);
}

/* ===== END FEATURE EXTENSIONS ===== */

function _moveDayTo(from,to){
  if(from===to||from<0||to<0||from>=state.days.length||to>=state.days.length)return;
  const [d]=state.days.splice(from,1);
  state.days.splice(to,0,d);
  if(currentDayIdx===from)currentDayIdx=to;
  else if(from<to&&currentDayIdx>from&&currentDayIdx<=to)currentDayIdx--;
  else if(from>to&&currentDayIdx>=to&&currentDayIdx<from)currentDayIdx++;
  saveState('Reordered days');renderAll();
  if(currentDayIdx>=0)renderDayMap(currentDayIdx);
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

async function init(){
  const localTrips=JSON.parse(localStorage.getItem('localTrips')||'[]');
  const isLocal=localTrips.some(t=>t.id===tripId);
  const isFamilyOverride=localStorage.getItem('tripFamily_'+tripId)==='1';
  const isFamily=isFamilyOverride||(BUILT_IN.includes(tripId)&&!localTrips.some(t=>t.id===tripId&&localStorage.getItem('tripFamily_'+tripId)==='0'));

  if(isFamily){
    try{
      const raw=await fetch(_familyBase()+'.json?nc='+Date.now(),{cache:'no-store'});
      const data=await raw.json();
      if(data&&data.state){
        state=data.state;
        _lastFamilyAt=(data.lastChange&&data.lastChange.at)||0;
        try{localStorage.setItem(LS_KEY,JSON.stringify(state))}catch(e){}
      }else{
        const saved=localStorage.getItem(LS_KEY);
        if(saved){state=JSON.parse(saved);}
        else{const r=await fetch('trips/'+tripId+'.json');state=await r.json();}
        state.tripType='family';
        _dbFamilyPut('/state',JSON.parse(JSON.stringify(state))).catch(()=>{});
      }
    }catch(e){
      const saved=localStorage.getItem(LS_KEY);
      if(saved){state=JSON.parse(saved);}
      else{
        try{const r=await fetch('trips/'+tripId+'.json');state=await r.json();}
        catch(e2){state={days:[],title:'Trip'};}
      }
    }
    if(!state.tripType)state.tripType='family';
    _startFamily();
  }else{
    const saved=localStorage.getItem(LS_KEY);
    if(saved){state=JSON.parse(saved);}
    else{
      try{const r=await fetch('trips/'+tripId+'.json');state=await r.json();}
      catch(e){state={days:[],title:'Trip'};}
    }
    if(!state.tripType)state.tripType='solo';
  }

  if(state.title)document.title='Seasons — '+state.title;
  if(state.mapCenter)map.setView(state.mapCenter,state.mapZoom||8);
  currentDayIdx=-1;
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
      if(changed){saveState();localStorage.removeItem('stop_desc_v1');}
    }
  }catch(e){}
  /* apply pending import from index.html (stored in sessionStorage to survive Firebase reload) */
  try{
    const pending=sessionStorage.getItem('pendingImport_'+tripId);
    if(pending){
      sessionStorage.removeItem('pendingImport_'+tripId);
      const parsedDays=JSON.parse(pending);
      const _isoFromSub=sub=>{if(!sub)return'';const p=sub.split(/\s*[·•]\s*/)[0].trim();const d=new Date(p+' 12:00');return isNaN(d)?'':(d.toISOString().slice(0,10));};
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
  renderAll();renderOverviewMap();loadTimezones();_setupTabDrag();
  _updateTypeBadge();
  if(isJournalMode()){const b=document.getElementById('journal-mode-banner');if(b)b.classList.add('on');}
  document.getElementById('ai-grader-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('ai-optimizer-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('share-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('travelers-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  document.getElementById('alternates-modal')?.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
  new ResizeObserver(updateTabScrollBtns).observe(document.getElementById('tabs-inner'));
  new ResizeObserver(updateTabsTop).observe(document.querySelector('header'));
  updateTabsTop();
  const imported=sessionStorage.getItem('justImported');
  if(imported){
    sessionStorage.removeItem('justImported');
    const b=document.getElementById('import-banner');
    b.innerHTML='✓ "'+imported+'" was added to your trips. You can now edit it independently.';
    b.classList.add('visible');
    setTimeout(()=>b.classList.remove('visible'),6000);
  }
}
init();
if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js');}