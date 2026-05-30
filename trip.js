const tripId=new URLSearchParams(location.search).get('id')||'utah';
const LS_KEY='tripState_'+tripId;
const PACK_KEY='seasons_packing_'+tripId;
let _isReadOnly=false;
const PROXY_URL='https://travel-ai-proxy.sps047.workers.dev';
function lsPack(val){
  if(val===undefined){try{return JSON.parse(localStorage.getItem(PACK_KEY)||'null')}catch(e){return null}}
  try{localStorage.setItem(PACK_KEY,JSON.stringify(val))}catch(e){}
}
/* ---- Collaboration config ----
   To enable real-time collaboration:
   1. Create a free Firebase project at console.firebase.google.com
   2. Add a Realtime Database (start in test mode)
   3. Replace null below with your Firebase config object
   4. (Optional) tighten security rules after testing
*/
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
function saveState(){
  try{localStorage.setItem(LS_KEY,JSON.stringify(state))}catch(e){}
  _syncCollab();
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
function flightAwareLink(name,notes){const text=(name||'')+' '+(notes||'');const m=text.match(/\b([A-Z][A-Z0-9]{1,2})\s*(\d{1,4})\b/);if(!m)return'';const ident=m[1]+m[2];return'<a class="map-link" href="https://flightaware.com/live/flight/'+ident+'" target="_blank" rel="noopener">&#9992; FlightAware</a>';}

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

function renderPanel(idx){
  const day=state.days[idx];if(!day)return'';
  const TRAVEL=new Set(['flight','train','drive']);
  const firstType=day.stops[0]?.type;
  const lastType=day.stops[day.stops.length-1]?.type;
  const hasExplicitLodge=day.stops.some(s=>s.type==='lodge');
  const prevHotel=getHotelForDay(idx-1);
  const todayHotel=getNextHotelForDay(idx);
  const showStart=!!prevHotel&&day.stops.length>0;
  const showEnd=!!todayHotel&&day.stops.length>0;
  let cards=showStart?hotelBookendHtml('Starting from',prevHotel,day.stops[0]):'';
  day.stops.forEach((s,si)=>{
    const isFirst=si===0,isLast=si===day.stops.length-1;
    const _tr=['flight','train','bus'].includes(s.type)?parsedTransitRoute(s):null;
    cards+='<div class="stop-card'+(s.alt?' alt-stop':'')+'">'+
      '<div class="stop-dot dot-'+(s.type||'drive')+'">'+(si+1)+'</div>'+
      '<div class="card-controls">'+
      '<button class="card-btn" onclick="moveStop('+idx+','+si+',-1)" title="Move up" '+(isFirst?'disabled':'')+'>&#9650;</button>'+
      '<button class="card-btn edit-btn" onclick="openEditStopModal('+idx+','+si+')" title="Edit stop">&#9998;</button>'+
      '<button class="card-btn" onclick="deleteStop('+idx+','+si+')" title="Remove" style="font-size:16px">&times;</button>'+
      '<button class="card-btn" onclick="moveStop('+idx+','+si+',1)" title="Move down" '+(isLast?'disabled':'')+'>&#9660;</button>'+
      '<button class="card-btn" onclick="openCopyModal('+idx+','+si+')" title="Copy to another day" style="font-size:11px">&#8599;</button>'+
      '</div>'+
      '<div class="card-top"><span class="card-time">'+(s.time||'')+(stopTz(s)&&s.time?'<span class="card-tz">'+stopTz(s).abbr+'</span>':'')+'</span><div class="card-main">'+
      '<div class="card-name">'+s.name+(s.alt?' <span style="font-weight:400;font-size:12px">(alternate)</span>':'')+'</div>'+
      (_tr?'<div class="card-notes" style="font-size:12px;font-weight:600;margin-top:3px">'+_tr.from+' → '+_tr.to+'</div>':'')+
      (s.stars?'<div class="card-stars">&#9733; '+s.stars+'</div>':'')+
      (s.notes?'<div class="card-notes">'+s.notes+'</div>':'')+
      (s.reservation?'<div class="card-notes" style="margin-top:4px;font-size:11.5px;font-weight:600;color:var(--pine);letter-spacing:0.03em">&#128203; Conf&nbsp;#&nbsp;'+s.reservation+'</div>':'')+
      '</div></div><div class="badges">'+badge(s.type)+(s.alt?'<span class="badge badge-alt">Alternate</span>':'')+(s.reservation?'<span class="badge badge-booked">&#10003; Booked</span>':(['lodge','flight','train','bus'].includes(s.type)||/pre-?book|book in advance|book now|sells out|timed entry|timed slot/i.test(s.notes||''))&&!/^depart\b/i.test(s.name)?'<span class="badge badge-tobook">&#128197; To Book</span>':'')+'</div>'+
      (s.lat&&s.lng?'<a class="map-link" href="https://www.google.com/maps/search/?api=1&query='+s.lat+','+s.lng+'" target="_blank" rel="noopener"><svg width="9" height="11" viewBox="0 0 30 36" fill="currentColor" style="flex-shrink:0"><path d="M15 0C7.268 0 1 6.268 1 14c0 8.836 14 22 14 22S29 22.836 29 14C29 6.268 22.732 0 15 0z"/></svg> Directions</a>':'')+
      (s.type==='flight'?flightAwareLink(s.name,s.notes):'')+
      (s.type==='lodge'&&isLast&&idx<state.days.length-1?'<button class="lodge-next-btn" onclick="openCopyModal('+idx+','+si+')">&#8594; Copy to start of Day '+(idx+2)+'</button>':'')+
      '<div class="stop-img-wrap" id="stopimg-'+idx+'-'+si+'" style="position:relative"></div>'+
      (!['drive','flight','train','bus'].includes(s.type)?'<div class="stopdesc-wrap" id="stopdesc-'+idx+'-'+si+'">'+(s.desc?'<div class="stop-desc"><span class="stop-desc-text">'+s.desc+'</span><button class="stop-desc-regen" onclick="refreshStopDesc('+idx+','+si+')" title="Regenerate">&#8635;</button></div>':'<button class="stop-desc-btn" onclick="generateStopDesc('+idx+','+si+')">&#10024; Describe</button>')+'</div>':'')+
      '</div>';
    if(!isLast){
      const next=day.stops[si+1];
      const leg=legLabel(s,next);
      const tzc=tzChangeLabel(s,next);
      if(leg||tzc){
        cards+='<div class="leg-connector"><span class="leg-connector-arrow">&#8595;</span>'+(leg||'')+
          (tzc?'<span class="tz-change" style="margin-left:'+(leg?'10px':'0')+'">&#9201; '+tzc+'</span>':'')+
          '</div>';
      }
    }
  });
  const panelCls='day-panel'+(idx===currentDayIdx?' active':'');
  return'<div class="'+panelCls+'" id="panel-'+idx+'">'+
    '<div class="day-header"><h2>'+day.title+'</h2>'+(day.subtitle?'<p>'+day.subtitle+'</p>':'')+'</div>'+
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
      el.innerHTML='<img class="stop-img" src="'+stop.customImage+'" alt="'+stop.name+'"/>';
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
async function fetchDayWeather(day){
  const sub=day.subtitle||'';
  const datePart=sub.split(/\s*[·•]\s*/)[0].trim();
  if(!datePart)return null;
  const date=new Date(datePart+' 12:00');
  if(isNaN(date.getTime())||date.getFullYear()<2020)return null;
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

const NARR_SYSTEM='You are a charismatic tour guide delivering the morning briefing to your group over breakfast. Format your response in exactly two parts separated by a single newline: (1) A weather line starting with a weather emoji, e.g. "☀️ Clear sky · High 82°F / Low 58°F · Forecast". End the weather line with the label from the prompt: "Forecast", "Historical", or "Climate Avg". Use the weather data if provided, otherwise estimate typical weather for this location and time of year and label it "Climate Avg". (2) Two to three flowing, engaging sentences about what the group will experience today, written in second person. Specific, evocative, exciting. Pure prose — no bullets, no headers.';

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
  const sig=day.title+'|'+day.stops.map(s=>s.name+(s.notes||'')).join('|');
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
    const stopList=day.stops.map(s=>s.name+(s.notes?' ('+s.notes+')':'')).join(', ');
    let userPrompt='Day: '+day.title+'\nStops: '+stopList;
    if(wx&&!wx.tooFarOut){
      const icon=WX_ICONS[wx.code]||'🌡️';
      const label=WX_LABELS[wx.code]||'';
      const typeLabel=wx.wxType==='historical'?'Historical':'Forecast';
      let precipNote='';
      if(wx.wxType==='historical'){if(wx.precip!=null&&wx.precip>0)precipNote=' · '+wx.precip+'mm rain';}
      else{if(wx.precip>=15)precipNote=' · '+wx.precip+'% rain';}
      userPrompt+='\nWeather ('+typeLabel+'): '+icon+' '+(label?label+' · ':'')+' High '+wx.hi+'°F / Low '+wx.lo+'°F'+precipNote+'\nWeather label: '+typeLabel;
    }else if(wx?.tooFarOut){
      userPrompt+='\nLocation: lat '+Number(wx.lat).toFixed(2)+', lon '+Number(wx.lng).toFixed(2)+'\nMonth: '+wx.month+'\nWeather label: Climate Avg\n(No forecast available — please estimate typical weather for this location in '+wx.month+')';
    }
    const text=await callClaude(NARR_SYSTEM,userPrompt);
    narrData[key]=text.trim();
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
  renderTabs();
  if(currentDayIdx===-1){
    document.getElementById('content-area').innerHTML=renderOverview();
  }else{
    document.getElementById('content-area').innerHTML=state.days.map((_,i)=>renderPanel(i)).join('');
    loadStopImages();
    if(currentDayIdx>=0)loadDayNarrative(currentDayIdx);
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

function moveStop(dayIdx,stopIdx,dir){
  const stops=state.days[dayIdx].stops;
  const newIdx=stopIdx+dir;
  if(newIdx<0||newIdx>=stops.length)return;
  [stops[stopIdx],stops[newIdx]]=[stops[newIdx],stops[stopIdx]];
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
  ['place-search','f-name','f-date','f-time','f-stars','f-lat','f-lng','f-notes','f-reservation','f-from','f-to','f-airline'].forEach(id=>{document.getElementById(id).value=''});
  document.getElementById('f-date').value=dayDateStr(dayIdx);
  document.getElementById('f-type').value='hike';
  document.getElementById('f-alt').checked=false;
  document.getElementById('search-results').innerHTML='';
  document.getElementById('search-results').classList.remove('open');
  pendingPhoto=null;showPhotoPreview(null);document.getElementById('f-photo').value='';
  pendingDesc=null;
  const _dd=document.getElementById('f-desc-display');if(_dd)_dd.textContent='';
  const _db=document.getElementById('f-desc-btn');if(_db){_db.textContent='✨ Generate Description';_db.disabled=false;}
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
  document.getElementById('f-alt').checked=!!s.alt;
  document.getElementById('search-results').innerHTML='';
  document.getElementById('search-results').classList.remove('open');
  pendingPhoto=s.customImage||null;showPhotoPreview(pendingPhoto);document.getElementById('f-photo').value='';
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
  const stopType=document.getElementById('f-type').value;
  const stop={name,lat,lng,type:stopType,time:document.getElementById('f-time').value.trim(),stars:document.getElementById('f-stars').value.trim()||null,notes:document.getElementById('f-notes').value.trim(),reservation:document.getElementById('f-reservation').value.trim()||null,from:document.getElementById('f-from').value.trim()||null,to:document.getElementById('f-to').value.trim()||null,airline:stopType==='flight'?(document.getElementById('f-airline').value.trim()||null):null,alt:document.getElementById('f-alt').checked,customImage};
  if(pendingDesc!==null){if(pendingDesc)stop.desc=pendingDesc;}
  else if(existingStop?.desc)stop.desc=existingStop.desc;
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
  saveState();closeModal();
  if(destDayIdx!==currentDayIdx&&destDayIdx>=0){switchDay(destDayIdx);}
  else{renderAll();if(srcDayIdx===currentDayIdx||destDayIdx===currentDayIdx)renderDayMap(currentDayIdx);}
}

/* ---- Overview ---- */
function generateChecklist(){
  const prev={};
  (state.checklist||[]).filter(i=>i.auto).forEach(i=>{prev[i.id]=i.done});
  const CK_KW=/pre-?book|book in advance|book now|sells out|timed entry|timed slot/i;
  const typePri={flight:0,train:1,lodge:2,hike:3,food:4,drive:5};
  const bookable=[];const seen=new Set();
  state.days.forEach((d,di)=>{
    d.stops.forEach((s,si)=>{
      if(/^depart\b/i.test(s.name))return;
      const needs=s.reservation||['lodge','flight','train'].includes(s.type)||CK_KW.test(s.notes||'');
      if(!needs)return;
      const nm=s.name.replace(/^check.?in\s*[—–\-]\s*/i,'').replace(/\s*[—–].*/,'').trim()||s.name;
      const key='auto-bk-'+s.type+'-'+nm.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,25);
      if(seen.has(key))return;seen.add(key);
      const isDone=key in prev?prev[key]:!!s.reservation;
      let text;
      if(s.type==='flight')text='Flight: '+nm+(s.reservation?' · '+s.reservation:'');
      else if(s.type==='train')text='Train: '+nm+(s.reservation?' · Ref '+s.reservation:'');
      else if(s.type==='lodge')text='Hotel: '+nm+(s.reservation?' · '+s.reservation:'');
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
    if(hasF){items.push({id:'auto-flights',text:'Book flights',done:prev['auto-flights']||false,auto:true});items.push({id:'auto-car',text:'Reserve rental car',done:prev['auto-car']||false,auto:true});}
    if(hasT)items.push({id:'auto-trains',text:'Book train tickets',done:prev['auto-trains']||false,auto:true});
    items.push({id:'auto-insurance',text:'Review travel insurance',done:prev['auto-insurance']||false,auto:true});
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
    return'<div class="cal-card" onclick="switchDay('+di+')" style="border-top:3px solid '+colors[di%4]+'">'+
      '<div class="cal-day-num">Day '+(di+1)+'</div>'+
      (datePart?'<div class="cal-date">'+datePart+'</div>':'')+
      '<div class="cal-theme">'+theme+'</div>'+
      '<div class="cal-stop-count">'+day.stops.length+' stop'+(day.stops.length!==1?'s':'')+'</div>'+
      '</div>';
  }).join('');

  const lodgeHtml=lodges.length?lodges.map(({di,day,s})=>{
    const nm=s.name.replace(/\s*[—–].*/,'').trim();
    const id='auto-lodge-'+nm.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,25);
    const booked=(state.checklist||[]).find(c=>c.id===id)?.done||false;
    const datePart=day.subtitle?day.subtitle.split(/\s*[·•]\s*/)[0].trim():'';
    return'<div class="lodge-card">'+
      '<div class="lodge-night-badge"><span class="lodge-night">Night '+(di+1)+'</span>'+(datePart?'<span class="lodge-date">'+datePart+'</span>':'')+'</div>'+
      '<div class="lodge-info"><div class="lodge-name">'+nm+'</div>'+(s.notes?'<div class="lodge-notes">'+s.notes+'</div>':'')+'</div>'+
      '<label class="lodge-booked"><input type="checkbox" '+(booked?'checked':'')+' onchange="toggleCheckItem(\''+id+'\',this.checked)"/> Booked</label>'+
      '</div>';
  }).join(''):'<div class="ov-empty">No lodging stops yet. Add stops with type "Lodging" to see them here.</div>';

  const checkHtml=state.checklist.map(item=>
    '<div class="check-item'+(item.done?' done':'')+'" id="chk-'+item.id+'">'+
    '<input type="checkbox" '+(item.done?'checked':'')+' onchange="toggleCheckItem(\''+item.id+'\',this.checked)"/>'+
    '<span class="check-text">'+item.text+'</span>'+
    (!item.auto?'<button class="chk-del" onclick="deleteCheckItem(\''+item.id+'\')">&#215;</button>':'')+
    '</div>'
  ).join('');

  /* Budget card */
  let budgetHtml='';
  if(state.budget&&state.budget.total){
    const bTotal=state.budget.type==='total'?state.budget.total:state.budget.total*state.days.length;
    const bPerDay=state.budget.type==='total'?Math.round(bTotal/state.days.length):state.budget.total;
    budgetHtml='<div class="budget-ov-card" style="margin-top:12px">'+
      '<div class="budget-ov-num">$'+Math.round(bTotal).toLocaleString()+'</div>'+
      '<div class="budget-ov-meta">Total budget · $'+bPerDay.toLocaleString()+'/day</div>'+
      '</div>';
  }

  return'<div class="ov-panel">'+
    '<div class="ov-section">'+(state.title?'<div class="ov-trip-name">'+state.title+'</div>':'')+statsHtml+budgetHtml+'</div>'+
    '<div class="ov-section"><div class="ov-heading">&#128197; Calendar</div><div class="cal-grid">'+calHtml+'</div></div>'+
    '<div class="ov-section"><div class="ov-heading">&#127970; Where You\'re Staying</div><div class="lodge-list">'+lodgeHtml+'</div></div>'+
    '<div class="ov-section"><div class="ov-heading">&#9989; Pre-Trip Checklist</div>'+
    '<div class="check-list">'+checkHtml+'</div>'+
    '<div class="add-check-row"><input type="text" id="new-check-input" class="add-check-input" placeholder="Add an item to book or pack..." onkeydown="if(event.key===\'Enter\')addCheckItem()"/><button class="add-check-btn" onclick="addCheckItem()">+ Add</button></div>'+
    '</div>'+
    '<div class="ov-section"><div class="ov-heading">&#128220; Packing List</div>'+renderPackingListHtml()+'</div>'+
    '</div>';
}

function toggleCheckItem(id,done){
  const item=(state.checklist||[]).find(i=>i.id===id);
  if(item){item.done=done;saveState();}
  const el=document.getElementById('chk-'+id);if(el)el.classList.toggle('done',done);
}
function addCheckItem(){
  const input=document.getElementById('new-check-input');
  const text=input.value.trim();if(!text)return;
  if(!state.checklist)state.checklist=[];
  const id='custom-'+Date.now();
  const item={id,text,done:false,auto:false};
  state.checklist.push(item);saveState();input.value='';
  const list=document.querySelector('.check-list');
  if(list){const el=document.createElement('div');el.className='check-item';el.id='chk-'+id;
    el.innerHTML='<input type="checkbox" onchange="toggleCheckItem(\''+id+'\',this.checked)"/><span class="check-text">'+text+'</span><button class="chk-del" onclick="deleteCheckItem(\''+id+'\')">&#215;</button>';
    list.appendChild(el);}
}
function deleteCheckItem(id){
  state.checklist=(state.checklist||[]).filter(i=>i.id!==id);saveState();
  const el=document.getElementById('chk-'+id);if(el)el.remove();
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
  const typeLabel={hike:'Hike / Park',food:'Food',lodge:'Lodging',drive:'Drive',flight:'Flight',train:'Train'};
  /* ---- Itinerary sheet ---- */
  const rows=[['Day','Date / Theme','Stop #','Time','Place','Type','Stars','Notes']];
  state.days.forEach((day,di)=>{
    const theme=day.title.replace(/^Day \d+\s*[—–]\s*/,'');
    const sub=day.subtitle||(day.title)||'';
    const datePart=sub.split(/\s*[·•]\s*/)[0].trim();
    if(day.stops.length===0){
      rows.push(['Day '+(di+1),datePart||theme,'','','(no stops yet)','','','']);
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
          s.notes||''
        ]);
      });
    }
  });
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!cols']=[{wch:8},{wch:22},{wch:7},{wch:10},{wch:32},{wch:10},{wch:7},{wch:44}];
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
  const filename=(state.title||'Itinerary').replace(/[/\\?%*:|"<>]/g,'-')+'.xlsx';
  XLSX.writeFile(wb,filename);
}

/* ---- Collaboration (Firebase REST API — no SDK, plain HTTPS + polling) ---- */
let _collabCode=null,_collabPoll=null;
let _lastSyncAt=0,_syncTimer=null;

function _sessionId(){
  let id=sessionStorage.getItem('_csid');
  if(!id){id=Math.random().toString(36).slice(2,8);sessionStorage.setItem('_csid',id);}
  return id;
}
function _genCode(){
  const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6},()=>a[Math.floor(Math.random()*a.length)]).join('');
}
function _dbUrl(code){
  return FIREBASE_CONFIG.databaseURL+'/trips/'+code+'.json';
}
async function _dbGet(code){
  const r=await fetch(_dbUrl(code));
  if(r.status===404)throw new Error('Database not found — go to console.firebase.google.com → your project → Realtime Database → Create Database → test mode');
  if(r.status===401||r.status===403)throw new Error('Access denied — go to Firebase Console → Realtime Database → Rules → set ".read": true, ".write": true → Publish');
  if(!r.ok)throw new Error('Server error '+r.status);
  return r.json();
}
async function _dbPut(code,data){
  const r=await fetch(_dbUrl(code),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  if(r.status===404)throw new Error('Database not found — go to console.firebase.google.com → your project → Realtime Database → Create Database → test mode');
  if(r.status===401||r.status===403)throw new Error('Access denied — go to Firebase Console → Realtime Database → Rules → set ".read": true, ".write": true → Publish');
  if(!r.ok)throw new Error('Server error '+r.status);
  return r.json();
}
async function _dbPatch(code,data){
  const r=await fetch(_dbUrl(code),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  if(!r.ok)return;
}
function _showCollabError(msg){
  const el=document.getElementById('collab-error');
  el.textContent=msg;el.style.display=msg?'block':'none';
}
function openCollabModal(){
  document.getElementById('collab-modal').classList.add('open');
  _showCollabError('');
  const startBtn=document.getElementById('start-collab-btn');
  if(startBtn){startBtn.textContent='Start Session';startBtn.disabled=false;}
  const joinBtn=document.getElementById('join-collab-btn');
  if(joinBtn){joinBtn.textContent='Join';joinBtn.disabled=false;}
  document.getElementById('collab-active-panel').style.display=_collabCode?'':'none';
  document.getElementById('collab-idle-panel').style.display=_collabCode?'none':'';
  if(_collabCode)document.getElementById('collab-code-display').textContent=_collabCode;
}
function closeCollabModal(){document.getElementById('collab-modal').classList.remove('open');}
async function startCollab(){
  const btn=document.getElementById('start-collab-btn');
  btn.textContent='Starting…';btn.disabled=true;
  _showCollabError('');
  try{
    if(!FIREBASE_CONFIG)throw new Error('Collaboration requires a Firebase config in trip.html.');
    _collabCode=_genCode();
    const snap={state:JSON.parse(JSON.stringify(state)),updatedAt:Date.now(),by:_sessionId()};
    await _dbPut(_collabCode,snap);
    _lastSyncAt=snap.updatedAt;
    document.getElementById('collab-idle-panel').style.display='none';
    document.getElementById('collab-active-panel').style.display='';
    document.getElementById('collab-code-display').textContent=_collabCode;
    btn.textContent='Start Session';btn.disabled=false;
    _updateCollabBtn();
    _watchCollab();
  }catch(e){
    _collabCode=null;
    _showCollabError('Could not start session: '+e.message);
    btn.textContent='Start Session';btn.disabled=false;
  }
}
async function joinCollab(){
  const raw=document.getElementById('collab-join-input').value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(raw.length<6){_showCollabError('Please enter the full 6-character code.');return;}
  const btn=document.getElementById('join-collab-btn');
  btn.textContent='Joining…';btn.disabled=true;
  _showCollabError('');
  try{
    if(!FIREBASE_CONFIG)throw new Error('Collaboration requires a Firebase config in trip.html.');
    const data=await _dbGet(raw);
    if(!data){_showCollabError('Code not found — double-check with your partner.');btn.textContent='Join';btn.disabled=false;return;}
    _collabCode=raw;
    state=data.state;
    _lastSyncAt=data.updatedAt||0;
    saveState();renderAll();
    _watchCollab();_updateCollabBtn();
    closeCollabModal();
    showToast('&#128101; Joined — you\'re now editing together');
    btn.textContent='Join';btn.disabled=false;
  }catch(e){
    _showCollabError('Could not join: '+e.message);
    btn.textContent='Join';btn.disabled=false;
  }
}
function _watchCollab(){
  if(_collabPoll)clearInterval(_collabPoll);
  _collabPoll=setInterval(async()=>{
    if(!_collabCode)return;
    try{
      const data=await _dbGet(_collabCode);
      if(!data||data.by===_sessionId()||(data.updatedAt||0)<=_lastSyncAt)return;
      _lastSyncAt=data.updatedAt;
      state=data.state;
      renderAll();
      showToast('&#9998; Your partner made a change');
    }catch(e){}
  },3000);
}
function _syncCollab(){
  if(!_collabCode)return;
  clearTimeout(_syncTimer);
  _syncTimer=setTimeout(()=>{
    const ts=Date.now();_lastSyncAt=ts;
    _dbPatch(_collabCode,{state:JSON.parse(JSON.stringify(state)),updatedAt:ts,by:_sessionId()});
  },600);
}
function confirmStopCollab(){
  if(!confirm('End the live session? Your partner will stop receiving updates.'))return;
  stopCollab();
}
function stopCollab(){
  clearTimeout(_syncTimer);
  if(_collabPoll)clearInterval(_collabPoll);
  _collabPoll=null;_collabCode=null;
  _updateCollabBtn();closeCollabModal();
  showToast('Session ended');
}
function _updateCollabBtn(){
  const btn=document.getElementById('collab-btn');
  if(_collabCode){
    btn.innerHTML='<span class="collab-live-dot"></span> Live: '+_collabCode;
    btn.classList.add('collab-live');
  }else{
    btn.innerHTML='&#128101; Collaborate';
    btn.classList.remove('collab-live');
  }
}
function copyCollabInvite(){
  if(!_collabCode)return;
  const url=location.origin+location.pathname+'?collab='+_collabCode;
  navigator.clipboard.writeText(url).then(()=>showToast('&#128279; Invite link copied — send it to your partner'));
}
function copyCollabCode(){
  if(!_collabCode)return;
  navigator.clipboard.writeText(_collabCode).then(()=>showToast('Code '+_collabCode+' copied'));
}

/* ---- lz-string lazy loader ---- */
function _loadLzString(){
  return new Promise((resolve,reject)=>{
    if(window.LZString){resolve();return;}
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js';
    s.onload=resolve;
    s.onerror=()=>reject(new Error('Could not load lz-string library'));
    document.head.appendChild(s);
  });
}

/* ---- Trip sharing ---- */
async function compressToBase64url(str){
  const bytes=new TextEncoder().encode(str);
  const cs=new CompressionStream('deflate-raw');
  const writer=cs.writable.getWriter();
  writer.write(bytes);writer.close();
  const buf=await new Response(cs.readable).arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
async function decompressFromBase64url(b64url){
  const b64=b64url.replace(/-/g,'+').replace(/_/g,'/');
  const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
  const ds=new DecompressionStream('deflate-raw');
  const writer=ds.writable.getWriter();
  writer.write(bytes);writer.close();
  const buf=await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}
function showToast(msg,duration=3000){
  const t=document.getElementById('share-toast');
  t.textContent=msg;t.classList.add('visible');
  setTimeout(()=>t.classList.remove('visible'),duration);
}
async function shareTrip(){
  try{
    await _loadLzString();
    const shareable=JSON.parse(JSON.stringify(state));
    (shareable.days||[]).forEach(d=>(d.stops||[]).forEach(s=>{if(s.customImage&&s.customImage.startsWith('data:'))delete s.customImage;}));
    const json=JSON.stringify(shareable);
    const encoded=LZString.compressToEncodedURIComponent(json);
    const url=location.origin+location.pathname+'#trip='+encoded;
    if(url.length>8000){showToast('&#9888; Link is very long — try removing photo attachments first',5000);return;}
    if(navigator.share){
      try{await navigator.share({title:state.title||'Trip Itinerary',url});return;}catch(e){/* fall through */}
    }
    await navigator.clipboard.writeText(url);
    showToast('&#128279; Link copied — anyone with it can view this trip');
  }catch(e){
    showToast('Could not copy link: '+e.message,4000);
  }
}

function saveSharedTrip(){
  const newId='shared-'+Date.now().toString(36);
  const tripCopy=JSON.parse(JSON.stringify(state));
  localStorage.setItem('tripState_'+newId,JSON.stringify(tripCopy));
  const entry={id:newId,title:tripCopy.title||'Shared Trip',dates:'',days:(tripCopy.days||[]).length,destinations:[],local:true};
  const local=JSON.parse(localStorage.getItem('localTrips')||'[]');
  local.push(entry);localStorage.setItem('localTrips',JSON.stringify(local));
  location.replace('trip.html?id='+newId);
}

function _applyReadOnly(){
  if(!_isReadOnly)return;
  document.querySelectorAll('.add-stop-btn,.card-controls,.tab-add,.tab-remove,.tab-move').forEach(el=>el.style.display='none');
  const collabBtn=document.getElementById('collab-btn');
  if(collabBtn)collabBtn.style.display='none';
}

function reloadOriginal(){
  localStorage.removeItem(LS_KEY);
  location.reload();
}

async function init(){
  /* Handle #trip= hash (read-only shared view) */
  const hash=location.hash;
  if(hash.startsWith('#trip=')){
    try{
      await _loadLzString();
      const encoded=hash.slice(6);
      const json=LZString.decompressFromEncodedURIComponent(encoded);
      if(!json)throw new Error('Could not decode link');
      const shared=JSON.parse(json);
      state=shared;
      _isReadOnly=true;
      history.replaceState(null,'',location.pathname+'?id='+tripId);
      if(state.title)document.title='Seasons — '+state.title+' (Shared)';
      if(state.mapCenter)map.setView(state.mapCenter,state.mapZoom||8);
      currentDayIdx=-1;
      renderAll();renderOverviewMap();loadTimezones();
      _applyReadOnly();
      new ResizeObserver(updateTabScrollBtns).observe(document.getElementById('tabs-inner'));
  new ResizeObserver(updateTabsTop).observe(document.querySelector('header'));
  updateTabsTop();
      document.getElementById('shared-trip-banner').style.display='flex';
      return;
    }catch(e){
      console.error('Hash trip decode failed',e);
      history.replaceState(null,'',location.pathname);
    }
  }

  /* Handle ?collab= invite link */
  const collabParam=new URLSearchParams(location.search).get('collab');
  if(collabParam){
    history.replaceState(null,'',location.pathname);
    document.getElementById('collab-join-input').value=collabParam;
    if(FIREBASE_CONFIG)joinCollab();else openCollabModal();
  }

  /* Handle legacy ?share= link (auto-save and redirect) */
  const shareParam=new URLSearchParams(location.search).get('share');
  if(shareParam){
    try{
      const json=await decompressFromBase64url(shareParam);
      const shared=JSON.parse(json);
      const newId='shared-'+Date.now().toString(36);
      localStorage.setItem('tripState_'+newId,JSON.stringify(shared));
      const entry={id:newId,title:shared.title||'Shared Trip',dates:'',days:(shared.days||[]).length,destinations:[],local:true};
      const local=JSON.parse(localStorage.getItem('localTrips')||'[]');
      local.push(entry);localStorage.setItem('localTrips',JSON.stringify(local));
      sessionStorage.setItem('justImported',shared.title||'Shared Trip');
      location.replace('trip.html?id='+newId);
      return;
    }catch(e){console.error('Share import failed',e);}
  }

  try{
    const localTrips=JSON.parse(localStorage.getItem('localTrips')||'[]');
    const isLocal=localTrips.some(t=>t.id===tripId&&t.local);
    const saved=localStorage.getItem(LS_KEY);
    if(saved&&isLocal){state=JSON.parse(saved);}
    else{
      if(saved){localStorage.removeItem(LS_KEY);}
      const r=await fetch('trips/'+tripId+'.json');state=await r.json();
    }
  }catch(e){state={days:[],title:'Trip'};}
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
  renderAll();renderOverviewMap();loadTimezones();
  new ResizeObserver(updateTabScrollBtns).observe(document.getElementById('tabs-inner'));
  new ResizeObserver(updateTabsTop).observe(document.querySelector('header'));
  updateTabsTop();
  const imported=sessionStorage.getItem('justImported');
  if(imported){
    sessionStorage.removeItem('justImported');
    const b=document.getElementById('import-banner');
    b.textContent='&#10003; "'+imported+'" was added to your trips. You can now edit it independently.';
    b.classList.add('visible');
    setTimeout(()=>b.classList.remove('visible'),6000);
  }
}
init();
if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js');}
