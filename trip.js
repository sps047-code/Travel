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
function legLabel(a,b){
  if(!a.lat||!a.lng||!b.lat||!b.lng)return'';
  const dist=haversine(a.lat,a.lng,b.lat,b.lng);
  if(dist<0.3)return'';
  const mi=dist<10?dist.toFixed(1):Math.round(dist);
  const isFlight=a.type==='flight'||b.type==='flight';
  const isTrain=!isFlight&&(a.type==='train'||b.type==='train');
  const isBus=!isFlight&&!isTrain&&(a.type==='bus'||b.type==='bus');
  const speed=isFlight?8:isTrain?1.8:isBus?1.4:1.15;
  const mins=Math.round(dist/speed);
  const tStr=mins<60?mins+' min':(Math.floor(mins/60)+'h'+(mins%60?' '+(mins%60)+'min':''));
  const mode=isFlight?' flight':isTrain?' train':isBus?' bus':' drive';
  return mi+' mi · '+tStr+mode;
}

function makeIcon(num,color,isAlt){
  const op=isAlt?0.6:1;
  return L.divIcon({html:`<svg xmlns="http://www.w3.org/2000/svg" width="30" height="36" viewBox="0 0 30 36"><path d="M15 0C7.268 0 1 6.268 1 14c0 8.836 14 22 14 22S29 22.836 29 14C29 6.268 22.732 0 15 0z" fill="${color}" fill-opacity="${op}" stroke="white" stroke-width="1.5"/><text x="15" y="16" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="11" font-weight="800" font-family="sans-serif">${num}</text></svg>`,className:'',iconSize:[30,36],iconAnchor:[15,36],popupAnchor:[0,-38]});
}

function bezierArc(p1,p2,steps=80){
  const [la1,lo1]=p1,[la2,lo2]=p2;
  const mla=(la1+la2)/2,mlo=(lo1+lo2)/2;
  const dla=la2-la1,dlo=lo2-lo1;
  const dist=Math.sqrt(dla*dla+dlo*dlo);
  const curve=dist*0.4;
  const cla=mla+(-dlo/dist*curve),clo=mlo+(dla/dist*curve);
  const pts=[];
  for(let i=0;i<=steps;i++){const t=i/steps;pts.push([(1-t)*(1-t)*la1+2*(1-t)*t*cla+t*t*la2,(1-t)*(1-t)*lo1+2*(1-t)*t*clo+t*t*lo2]);}
  return pts;
}

async function fetchRoute(stops){
  const rs=stops.filter((s,i)=>{
    if(s.alt||!s.lat||!s.lng)return false;
    if(s.type==='flight'){const nx=stops[i+1];return !nx||nx.type!=='flight';}
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
    if(a.type==='flight'&&b.type==='flight'&&a.lat&&b.lat){
      L.polyline(bezierArc([a.lat,a.lng],[b.lat,b.lng]),{color:'#4A7EC7',weight:2.5,opacity:0.8,dashArray:'8,5'}).addTo(routeLayer);
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
    const mins=Math.round(dist/0.5);
    const tStr=mins<60?mins+' min':(Math.floor(mins/60)+'h'+(mins%60?' '+(mins%60)+'min':''));
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