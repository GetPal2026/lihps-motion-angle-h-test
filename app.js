import {setupHTest} from './h-test.js';
import {
  validOrientation, orientationSample, gravityInclinometer, relativeRotation,
  circularMeanDegrees, circularSpreadDegrees, wrap180, quatNormalize
} from './math.js';

/* LIHPS Motion Angle PWA — 0.3.0
   Research prototype. Web orientation is not interchangeable with native Core Motion.
   Every incoming orientation sample is processed before the throttled UI refresh. */
const $=id=>document.getElementById(id);
const fmt=(v,n=1)=>Number.isFinite(v)?v.toFixed(n):'—';
const signed=(v,n=1)=>Number.isFinite(v)?`${v>=0?'+':''}${v.toFixed(n)}°`:'—';
const degrees=v=>Number.isFinite(v)?`${v.toFixed(1)}°`:'—';
const RECORD_KEY='lihps-motion-h-test-legacy-records-v1';
const SESSION_KEY='lihps-motion-h-test-legacy-session-v1';
const TILT_WARN=15;
const BASELINE_MS=650;
const MIN_ZERO_SAMPLES=10;
const ZERO_SPREAD_LIMIT=2.5;
const MAX_ZERO_MS=4500;
const SENSOR_STALE_MS=1200;
const MAX_RECORDS=2000;
const recordTypes={trunk:'Trunk rotation',rom:'ROM from zero',inclinometer:'Inclinometer',segments:'Two-segment angle'};
let warning='';

let records=readStorage(RECORD_KEY,[]);
if(!Array.isArray(records))records=[];
let sessionId=readStorage(SESSION_KEY,null)||createSessionId();
writeStorage(SESSION_KEY,sessionId);
let screen='trunk',tool='inclinometer',direction='unspecified',inclinoEdge='long',segmentEdge='long';
let enabled=false,permissionRequested=false,orientationSeen=false,sensorError='';
let latest=null,previousSample=null,sampleTimes=[],recentHeading=[];
let lastRendered=0,renderPending=false;
let recentOrientations=[];
let audio=null;
const trunk={phase:'ready',baseline:null,lastHeading:null,lastTime:null,current:0,peak:0,signedPeak:0,maxTilt:0,started:0,zeroStarted:0,result:null,zeroSamples:[]};
const rom={phase:'ready',baseline:null,current:{x:0,y:0,z:0,magnitude:0},peaks:{x:0,y:0,z:0,magnitude:0},started:0,zeroStarted:0,result:null,zeroSamples:[]};
const segments={stage:0,proximal:null,distal:null,result:null};

function createSessionId(){const d=new Date().toISOString().slice(0,10);return `${d}-${Math.random().toString(36).slice(2,7)}`;}
function readStorage(key,fallback){try{const x=localStorage.getItem(key);return x===null?fallback:JSON.parse(x);}catch{return fallback;}}
function writeStorage(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{setWarning('Local storage is unavailable or full. Export your measurements now; further trials may not be saved.');return false;}}
function setWarning(message){warning=message;const el=$('global-warning');el.textContent=message;el.hidden=!message;}
function clearWarning(){setWarning('');}
function saveRecord(type,data){const entry={id:Date.now()+'-'+Math.random().toString(36).slice(2,8),time:new Date().toISOString(),sessionId,type,version:'0.3.0',...data};
  records.unshift(entry);if(records.length>MAX_RECORDS)records.length=MAX_RECORDS;
  const ok=writeStorage(RECORD_KEY,records);if(!ok)entry.notSaved=true;
  renderRecords();renderTrunkSession();return entry;
}
function sensorFresh(){return enabled&&orientationSeen&&latest&&(performance.now()-latest.time)<SENSOR_STALE_MS;}
function updatePermissionBanner(){const ready=sensorFresh();const el=$('sensor-banner');el.classList.toggle('ready',!!ready);el.classList.toggle('error',!!sensorError);
  $('sensor-dot').className='status-dot';$('sensor-status').textContent=sensorError?'Sensor access problem':ready?'Motion sensors active':permissionRequested?'Waiting for orientation…':'Sensors not enabled';
  $('sensor-explainer').textContent=sensorError|| (ready?`Receiving device orientation · ${sampleTimes.length?'~'+fmt(estimatedRate(),0)+' Hz':'sampling'}`:permissionRequested?'Move the iPhone gently; check browser permission if no data arrives.':'Safari needs motion permission; a secure HTTPS page is required.');
  $('sensor-enable').hidden=!!ready; $('sensor-enable').textContent=permissionRequested?'Retry':'Enable';
}
function estimatedRate(){if(sampleTimes.length<3)return null;const n=sampleTimes.length-1,span=sampleTimes.at(-1)-sampleTimes[0];return span>0?1000*n/span:null;}
async function enableSensors(){
  if(!window.isSecureContext){sensorError='Open this app from an HTTPS website. Local file opening does not allow motion access.';updatePermissionBanner();return;}
  if(!('DeviceOrientationEvent'in window)){sensorError='DeviceOrientationEvent is not available in this browser/device.';updatePermissionBanner();return;}
  sensorError='';permissionRequested=true;updatePermissionBanner();
  // Start BOTH permission requests in the same tap handler, before the first await.
  const asks=[];
  try {
    if(typeof DeviceOrientationEvent.requestPermission==='function')asks.push(DeviceOrientationEvent.requestPermission());
    if('DeviceMotionEvent'in window&&typeof DeviceMotionEvent.requestPermission==='function')asks.push(DeviceMotionEvent.requestPermission());
  }catch(error){sensorError=`Permission request failed: ${error.message}`;updatePermissionBanner();return;}
  const decisions=await Promise.allSettled(asks);
  // Orientation is mandatory. Motion access is a complementary diagnostic.
  if(asks.length&&decisions[0]?.status==='fulfilled'&&decisions[0].value==='denied'){
    sensorError='Orientation permission denied. Check Safari or web-app settings and try again.';
    updatePermissionBanner();return;
  }
  if(decisions.some(p=>p.status==='rejected')){
    sensorError='Permission request failed. Try again after a fresh user tap.';updatePermissionBanner();return;
  }
  enabled=true;
  updatePermissionBanner();renderLive();
  setTimeout(()=>{if(enabled&&!orientationSeen){sensorError='No orientation samples arrived. Use Safari on an iPhone and allow Motion & Orientation access.';updatePermissionBanner();}},5500);
}
function requestPermissions(){enableSensors().catch(error=>{sensorError=String(error.message||error);updatePermissionBanner();});}
function onOrientation(e){
  if(!enabled||!validOrientation(e.alpha,e.beta,e.gamma))return;
  const now=performance.now();const sample=orientationSample(e.alpha,e.beta,e.gamma,e.absolute===true,now);
  latest=sample;orientationSeen=true;sampleTimes.push(now);
  while(sampleTimes.length>40)sampleTimes.shift();
  recentHeading.push({t:now,angle:sample.heading});
  while(recentHeading.length&&recentHeading[0].t<now-10000)recentHeading.shift();
  recentOrientations.push(sample);while(recentOrientations.length&&recentOrientations[0].time<now-850)recentOrientations.shift();
  processTrunk(sample);processRom(sample);
  previousSample=sample;
  if(now-lastRendered>70)scheduleRender();
}
function scheduleRender(){if(renderPending)return;renderPending=true;requestAnimationFrame(()=>{renderPending=false;lastRendered=performance.now();renderLive();});}
function interruptActiveTrials(message){let interrupted=false;if(trunk.phase==='zeroing'||trunk.phase==='measuring'){trunk.phase='interrupted';trunk.result=null;interrupted=true;}
  if(rom.phase==='zeroing'||rom.phase==='measuring'){rom.phase='interrupted';rom.result=null;interrupted=true;}
  if(message&&interrupted)setWarning(message);if(interrupted)renderLive();}
function setScreen(target){if(screen===target)return;interruptActiveTrials('An active measurement was interrupted when switching screens. Restart the trial.');
  screen=target;document.querySelectorAll('.screen').forEach(el=>{const active=el.id===`screen-${screen}`;el.hidden=!active;el.classList.toggle('active',active);});
  document.querySelectorAll('.nav-item').forEach(el=>{const active=el.dataset.screen===screen;el.classList.toggle('selected',active);if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  window.scrollTo({top:0,behavior:'instant'});renderLive();
}
function setTool(target){if(tool===target)return;interruptActiveTrials('The active trial was interrupted when changing tools.');tool=target;
  document.querySelectorAll('.joint-tool').forEach(el=>el.hidden=el.id!==`tool-${tool}`);
  document.querySelectorAll('[data-tool]').forEach(el=>{const b=el.dataset.tool===tool;el.classList.toggle('selected',b);el.setAttribute('aria-pressed',String(b));});renderLive();
}
function chooseInGroup(selector,attribute,value){document.querySelectorAll(selector).forEach(el=>{const chosen=el.dataset[attribute]===value;el.classList.toggle('selected',chosen);el.setAttribute('aria-pressed',String(chosen));});}
function beep(){try{if(!audio)return;const o=audio.createOscillator(),g=audio.createGain();o.type='sine';o.frequency.value=830;g.gain.value=.065;o.connect(g);g.connect(audio.destination);const t=audio.currentTime;g.gain.setValueAtTime(.06,t);g.gain.exponentialRampToValueAtTime(.0001,t+.11);o.start(t);o.stop(t+.12);}catch{}}
function prepareAudio(){try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return;if(!audio)audio=new C();if(audio.state==='suspended')audio.resume().catch(()=>{});}catch{}}
function vibrate(){if(navigator.vibrate)try{navigator.vibrate(45);}catch{}}
function startTrunk(){if(!sensorFresh()){setWarning('No fresh orientation samples. Enable sensor access and try again.');return;}
  clearWarning();prepareAudio();Object.assign(trunk,{phase:'zeroing',baseline:null,lastHeading:null,lastTime:null,current:0,peak:0,signedPeak:0,maxTilt:0,started:0,zeroStarted:performance.now(),result:null,zeroSamples:[]});renderLive();
}
function processTrunk(sample){if(trunk.phase==='zeroing'){
    if(sample.time-trunk.zeroStarted>MAX_ZERO_MS){trunk.phase='interrupted';setWarning('Unable to zero: hold the phone horizontally and completely still, then tap to retry.');return;}
    trunk.zeroSamples.push(sample);trunk.zeroSamples=trunk.zeroSamples.filter(s=>s.time>=sample.time-BASELINE_MS);
    const a=trunk.zeroSamples;
    if(a.length<MIN_ZERO_SAMPLES||a.at(-1).time-a[0].time<500)return;
    const spread=circularSpreadDegrees(a.map(s=>s.heading));const maxTilt=Math.max(...a.map(s=>s.screenTilt));
    if(spread>ZERO_SPREAD_LIMIT||maxTilt>20||Math.min(...a.map(s=>s.horizontalY))<.7)return;
    trunk.baseline=circularMeanDegrees(a.map(s=>s.heading));trunk.lastHeading=sample.heading;trunk.lastTime=sample.time;
    trunk.started=sample.time;trunk.phase='measuring';beep();vibrate();return;
  }
  if(trunk.phase!=='measuring')return;
  if(trunk.lastTime!==null){const dt=sample.time-trunk.lastTime;
    if(dt>SENSOR_STALE_MS){trunk.phase='interrupted';setWarning('Sensor data gap: trunk measurement discarded. Tap to restart.');return;}
    const inc=wrap180(sample.heading-trunk.lastHeading);
    if(dt<120&&Math.abs(inc)>30){trunk.phase='interrupted';setWarning('Abrupt heading discontinuity detected; trial discarded. Check for magnetic interference or sensor instability.');return;}
    if(sample.horizontalY<.55){trunk.phase='interrupted';setWarning('Phone long axis became too vertical to determine horizontal rotation. Repeat the trial.');return;}
    trunk.current+=inc;
    trunk.lastHeading=sample.heading;trunk.lastTime=sample.time;
    if(Math.abs(trunk.current)>trunk.peak){trunk.peak=Math.abs(trunk.current);trunk.signedPeak=trunk.current;}
    trunk.maxTilt=Math.max(trunk.maxTilt,sample.screenTilt);
  }
}
function finishTrunk(){if(trunk.phase!=='measuring')return;
  const duration=(performance.now()-trunk.started)/1000;
  const result={peakDeg:trunk.peak,signedPeakDeg:trunk.signedPeak,maxTiltDeg:trunk.maxTilt,durationSec:duration,direction,
    sourceAbsolute:latest?.absolute??false,flagTilt:trunk.maxTilt>TILT_WARN,method:'horizontal projected device long axis; continuous unwrapped orientation'};
  trunk.result=saveRecord('trunk',result);trunk.phase='result';beep();vibrate();renderLive();
}
function trunkTap(){if(!sensorFresh()&&trunk.phase!=='result'){setWarning('Enable sensor access first; this measurement requires live orientation data.');return;}
  if(trunk.phase==='ready'||trunk.phase==='result'||trunk.phase==='interrupted')startTrunk();else if(trunk.phase==='measuring')finishTrunk();}
function startRom(){if(!sensorFresh()){setWarning('No fresh orientation samples. Enable sensor access first.');return;}
  clearWarning();prepareAudio();Object.assign(rom,{phase:'zeroing',baseline:null,current:{x:0,y:0,z:0,magnitude:0},peaks:{x:0,y:0,z:0,magnitude:0},started:0,zeroStarted:performance.now(),zeroSamples:[],result:null});renderLive();}
function averageQuaternions(quats){const base=quats[0],sum={w:0,x:0,y:0,z:0};for(const q of quats){const sign=(base.w*q.w+base.x*q.x+base.y*q.y+base.z*q.z)>=0?1:-1;for(const k of ['w','x','y','z'])sum[k]+=sign*q[k];}return quatNormalize(sum);}
function processRom(sample){if(rom.phase==='zeroing'){
    if(sample.time-rom.zeroStarted>MAX_ZERO_MS){rom.phase='interrupted';setWarning('Unable to zero ROM: keep the phone still and try again.');return;}
    rom.zeroSamples.push(sample);rom.zeroSamples=rom.zeroSamples.filter(s=>s.time>=sample.time-BASELINE_MS);
    const a=rom.zeroSamples;if(a.length<MIN_ZERO_SAMPLES||a.at(-1).time-a[0].time<500)return;
    const baseline=a[0].q;
    if(Math.max(...a.map(s=>relativeRotation(baseline,s.q).magnitude))>ZERO_SPREAD_LIMIT)return;
    rom.baseline=averageQuaternions(a.map(s=>s.q));rom.started=sample.time;rom.phase='measuring';beep();vibrate();return;
  }
  if(rom.phase!=='measuring')return;
  const r=relativeRotation(rom.baseline,sample.q);rom.current=r;
  for(const k of ['x','y','z'])rom.peaks[k]=Math.max(rom.peaks[k],Math.abs(r[k]));
  rom.peaks.magnitude=Math.max(rom.peaks.magnitude,r.magnitude);
}
function finishRom(){if(rom.phase!=='measuring')return;
  rom.result=saveRecord('rom',{peakDeg:rom.peaks.magnitude,peakXDeg:rom.peaks.x,peakYDeg:rom.peaks.y,peakZDeg:rom.peaks.z,durationSec:(performance.now()-rom.started)/1000,
    sourceAbsolute:latest?.absolute??false,method:'quaternion relative orientation; separate device-axis Z-X-Y Euler peaks'});
  rom.phase='result';beep();vibrate();renderLive();}
function romTap(){if(!sensorFresh()&&rom.phase!=='result'){setWarning('Enable live orientation data first.');return;}
  if(['ready','result','interrupted'].includes(rom.phase))startRom();else if(rom.phase==='measuring')finishRom();}
function currentInclination(edge){return latest?gravityInclinometer(latest.gravity,edge):null;}
function recentStableInclination(edge){const now=performance.now(),arr=recentOrientations.filter(s=>s.time>now-700);
  if(arr.length<6||arr.at(-1).time-arr[0].time<350)return false;
  const angles=arr.map(s=>gravityInclinometer(s.gravity,edge).angle);
  const base=angles[0];return Math.max(...angles.map(a=>Math.abs(wrap180(a-base))))<=2.5;
}
function captureInclination(){if(!sensorFresh())return setWarning('Enable sensors first.');
  if(!recentStableInclination(inclinoEdge))return setWarning('Hold the phone still for approximately half a second before recording.');
  clearWarning();const v=currentInclination(inclinoEdge);
  saveRecord('inclinometer',{valueDeg:v.angle,absoluteDeg:Math.abs(v.angle),outOfPlaneDeg:v.outOfPlane,edge:inclinoEdge,flagOutOfPlane:v.outOfPlane>TILT_WARN,
    method:'gravity orientation; signed planar inclination relative to phone-screen-normal plane'});
  $('inclino-quality').textContent=`Recorded ${signed(v.angle)} (${v.outOfPlane>TILT_WARN?'out-of-plane warning':'position acceptable'}).`;
}
function captureSegments(){if(!sensorFresh())return setWarning('Enable sensors first.');
  if(segments.stage===2){resetSegments();return;}
  if(!recentStableInclination(segmentEdge))return setWarning('Hold the phone still for approximately half a second before capturing the segment.');
  clearWarning();const v=currentInclination(segmentEdge);
  if(segments.stage===0){segments.proximal=v;segments.stage=1;}
  else if(segments.stage===1){segments.distal=v;segments.stage=2;
    const diff=Math.abs(wrap180(segments.distal.angle-segments.proximal.angle));segments.result=diff;
    saveRecord('segments',{valueDeg:diff,proximalDeg:segments.proximal.angle,distalDeg:segments.distal.angle,edge:segmentEdge,
      maxOutOfPlaneDeg:Math.max(segments.proximal.outOfPlane,segments.distal.outOfPlane),method:'difference between sequential planar inclinations; co-planar assumption'});
  }
  renderLive();
}
function resetSegments(){Object.assign(segments,{stage:0,proximal:null,distal:null,result:null});renderLive();}
function statsForSession(){return records.filter(r=>r.type==='trunk'&&r.sessionId===sessionId);}
function renderTrunkSession(){const trials=statsForSession(),values=trials.map(r=>r.peakDeg).filter(Number.isFinite);
  $('stat-count').textContent=String(trials.length);
  $('stat-mean').textContent=values.length?degrees(values.reduce((s,v)=>s+v,0)/values.length):'—';
  $('stat-range').textContent=values.length>=2?degrees(Math.max(...values)-Math.min(...values)):'—';
  $('recent-trunk').replaceChildren();$('discard-trunk').hidden=!trials.length;
  if(!trials.length){const e=document.createElement('div');e.className='empty-inline';e.textContent='No recorded trials yet.';$('recent-trunk').append(e);return;}
  trials.slice(0,6).forEach((r,i)=>{const el=document.createElement('div');el.className='recent-item';const left=document.createElement('div');const title=document.createElement('span');title.textContent=`Trial ${trials.length-i} · ${r.direction==='unspecified'?'Either direction':r.direction}`;
    const sub=document.createElement('small');sub.textContent=`${new Date(r.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}${r.flagTilt?' · tilt warning':''}`;
    const value=document.createElement('strong');value.textContent=degrees(r.peakDeg);left.append(title,sub);el.append(left,value);$('recent-trunk').append(el);});
}

function renderRecords(){const list=$('records-list');list.replaceChildren();$('record-count').textContent=`${records.length} locally stored record${records.length===1?'':'s'}`;
  if(!records.length){const el=document.createElement('div');el.className='empty-inline';el.textContent='No measurements recorded yet.';list.append(el);return;}
  records.slice(0,100).forEach(r=>{const el=document.createElement('div');el.className='record-item';const left=document.createElement('div');const title=document.createElement('span');title.textContent=recordTypes[r.type]||r.type;const sub=document.createElement('small');
    sub.textContent=`${new Date(r.time).toLocaleString()} · ${r.type==='trunk'&&r.direction!=='unspecified'?r.direction+' · ':''}${r.sessionId}`;
    const value=document.createElement('strong');value.textContent=degrees(r.peakDeg??r.valueDeg);left.append(title,sub);el.append(left,value);list.append(el);});
  if(records.length>100){const note=document.createElement('div');note.className='notice quality';note.textContent=`Showing 100 recent records; CSV includes all ${records.length}.`;list.append(note);}
}
function renderDiagnostics(){const yes=(id,x)=>{$(id).textContent=x?'Yes':'No';$(id).classList.toggle('good-text',!!x);$(id).classList.toggle('bad-text',!x);};
  yes('diag-https',window.isSecureContext);yes('diag-orient-api','DeviceOrientationEvent'in window);yes('diag-motion-api','DeviceMotionEvent'in window);
  $('diag-last').textContent=latest?`${Math.round((performance.now()-latest.time)/1000*10)/10} s ago`:'No samples yet';
  const rate=estimatedRate();$('diag-rate').textContent=rate?`${fmt(rate,0)} Hz`:'—';
  $('diag-absolute').textContent=latest?(latest.absolute?'True (potential magnetic influence)':'False / relative reported'):'—';
  $('diag-tilt').textContent=latest?degrees(latest.screenTilt):'—';
  $('diag-jitter').textContent=recentHeading.length>=4?degrees(circularSpreadDegrees(recentHeading.map(x=>x.angle))):'—';
}
function renderLive(){updatePermissionBanner();const active=sensorFresh();
  $('trunk-tap').disabled=!active&&!['result','interrupted'].includes(trunk.phase);
  $('trunk-phase').textContent={ready:'READY TO MEASURE',zeroing:'ZEROING · KEEP STILL',measuring:'MEASURING',result:'TRIAL RECORDED',interrupted:'MEASUREMENT INTERRUPTED'}[trunk.phase];
  $('trunk-live').hidden=trunk.phase!=='measuring';
  $('trunk-peak').textContent=fmt(trunk.peak);$('trunk-current').textContent=signed(trunk.current);
  $('trunk-tilt').textContent=(trunk.phase==='ready'||trunk.phase==='zeroing')?'—':degrees(trunk.maxTilt);
  $('angle-meter-fill').style.width=`${Math.min(100,trunk.peak/180*100)}%`;
  const trunkCommands={ready:'TAP TO ZERO & START',zeroing:'HOLD STILL · ZEROING',measuring:'TAP WHEN FINISHED',result:'TAP FOR NEXT TRIAL',interrupted:'TAP TO RESTART'};
  $('trunk-command').textContent=active||trunk.phase!=='ready'?trunkCommands[trunk.phase]:'ENABLE SENSORS FIRST';
  $('trunk-command-detail').textContent=trunk.phase==='measuring'?'Peak is retained automatically; do not tap at end range.':
    trunk.phase==='result'?`Recorded ${degrees(trunk.result?.peakDeg)} · ${direction==='unspecified'?'either side':direction} selected`:
    trunk.phase==='zeroing'?'Keep the phone flat and completely still.':'Screen upward · long edge against sternum';
  $('trunk-quality').textContent=trunk.maxTilt>TILT_WARN&&trunk.phase!=='ready'?`Quality warning: maximum screen tilt ${degrees(trunk.maxTilt)} exceeds the provisional ${TILT_WARN}° threshold.`:
    trunk.phase==='result'?`Recorded locally. This is phone rotation relative to the room, not thorax–pelvis separation.`:
    'Maintain contact with the sternum; minimise arm movement. Stabilise the pelvis as required by your test protocol.';
  $('rom-tap').disabled=!active&&!['result','interrupted'].includes(rom.phase);
  $('rom-phase').textContent={ready:'READY TO MEASURE',zeroing:'ZEROING · KEEP STILL',measuring:'MEASURING',result:'TRIAL RECORDED',interrupted:'MEASUREMENT INTERRUPTED'}[rom.phase];
  $('rom-live').hidden=rom.phase!=='measuring';
  $('rom-magnitude').textContent=fmt(rom.peaks.magnitude);
  for(const k of ['x','y','z'])$('rom-'+k).textContent=degrees(rom.peaks[k]);
  $('rom-command').textContent=active||rom.phase!=='ready'?{ready:'TAP TO ZERO & START',zeroing:'HOLD STILL · ZEROING',measuring:'TAP WHEN FINISHED',result:'TAP FOR NEXT TRIAL',interrupted:'TAP TO RESTART'}[rom.phase]:'ENABLE SENSORS FIRST';
  $('rom-detail').textContent=rom.phase==='measuring'?'Every sensor sample contributes to the peak.':'Zero → move → tap to save peak';
  $('capture-inclinometer').disabled=!active;$('segments-capture').disabled=!active;
  const inc=currentInclination(inclinoEdge);
  $('inclino-angle').textContent=inc?`${inc.angle>=0?'+':''}${fmt(inc.angle)}`:'—';
  $('inclino-absolute').textContent=inc?degrees(Math.abs(inc.angle)):'—';
  $('inclino-oop').textContent=inc?degrees(inc.outOfPlane):'—';
  if(segments.stage===2){$('segments-title').textContent='TWO-SEGMENT PLANAR ANGLE';$('segments-angle').textContent=fmt(segments.result);$('segments-label').textContent='Unsigned angle difference · co-planar assumption';$('segments-capture').textContent='Begin next two-segment angle';}
  else{$('segments-title').textContent=segments.stage===0?'PLACE ON PROXIMAL SEGMENT':'PLACE ON DISTAL SEGMENT';$('segments-angle').textContent=fmt(currentInclination(segmentEdge)?.angle);$('segments-label').textContent='Live signed inclination relative to horizontal';$('segments-capture').textContent=segments.stage===0?'Capture proximal segment':'Capture distal segment';}
  $('segments-proximal').textContent=segments.proximal?signed(segments.proximal.angle):'—';
  $('segments-distal').textContent=segments.distal?signed(segments.distal.angle):'—';
  if(screen==='info')renderDiagnostics();
}
function escapeCsv(v){if(v===null||v===undefined)return '';const s=String(v);return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;}
function exportCsv(){if(!records.length){setWarning('No records to export yet.');return;}
  const fields=['id','time','sessionId','type','direction','peakDeg','signedPeakDeg','valueDeg','absoluteDeg','maxTiltDeg','outOfPlaneDeg','maxOutOfPlaneDeg','peakXDeg','peakYDeg','peakZDeg','proximalDeg','distalDeg','durationSec','edge','flagTilt','flagOutOfPlane','sourceAbsolute','method','version'];
  const csv='\ufeff'+fields.join(',')+'\r\n'+records.map(r=>fields.map(k=>escapeCsv(r[k])).join(',')).join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;
  a.download=`LIHPS_Motion_Angle_${new Date().toISOString().slice(0,10)}.csv`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function newSession(){if(['zeroing','measuring'].includes(trunk.phase)||['zeroing','measuring'].includes(rom.phase))return setWarning('Finish or discard the active measurement before starting a new session.');
  if(!window.confirm('Start a new session? Previous measurements remain in Records.'))return;
  sessionId=createSessionId();writeStorage(SESSION_KEY,sessionId);trunk.phase='ready';trunk.current=0;trunk.peak=0;trunk.maxTilt=0;trunk.result=null;renderTrunkSession();renderLive();
}
function deleteAllRecords(){if(!records.length)return;if(!window.confirm('Permanently delete ALL local measurements? Export CSV first if needed.'))return;
  records=[];writeStorage(RECORD_KEY,records);sessionId=createSessionId();writeStorage(SESSION_KEY,sessionId);renderRecords();renderTrunkSession();}
function discardLastTrunk(){const index=records.findIndex(r=>r.type==='trunk'&&r.sessionId===sessionId);if(index<0)return;
  if(!window.confirm('Delete the most recent trunk trial in this session?'))return;
  records.splice(index,1);writeStorage(RECORD_KEY,records);if(trunk.phase==='result'){trunk.phase='ready';trunk.peak=0;trunk.current=0;trunk.maxTilt=0;trunk.result=null;}renderRecords();renderTrunkSession();renderLive();}
function wireUI(){
  $('sensor-enable').addEventListener('click',requestPermissions);$('enable-again').addEventListener('click',requestPermissions);
  $('trunk-tap').addEventListener('click',trunkTap);$('rom-tap').addEventListener('click',romTap);
  $('capture-inclinometer').addEventListener('click',captureInclination);$('segments-capture').addEventListener('click',captureSegments);
  $('segments-reset').addEventListener('click',resetSegments);
  $('new-session').addEventListener('click',newSession);$('discard-trunk').addEventListener('click',discardLastTrunk);
  $('export-csv').addEventListener('click',exportCsv);$('clear-records').addEventListener('click',deleteAllRecords);
  document.querySelectorAll('[data-screen]').forEach(el=>el.addEventListener('click',()=>setScreen(el.dataset.screen)));
  document.querySelectorAll('[data-tool]').forEach(el=>el.addEventListener('click',()=>setTool(el.dataset.tool)));
  document.querySelectorAll('[data-direction]').forEach(el=>el.addEventListener('click',()=>{direction=el.dataset.direction;chooseInGroup('[data-direction]','direction',direction);renderLive();}));
  document.querySelectorAll('#inclino-edge [data-edge]').forEach(el=>el.addEventListener('click',()=>{inclinoEdge=el.dataset.edge;chooseInGroup('#inclino-edge [data-edge]','edge',inclinoEdge);renderLive();}));
  document.querySelectorAll('#segment-edge [data-edge]').forEach(el=>el.addEventListener('click',()=>{if(segments.stage===1)return setWarning('Finish or reset the two-segment measurement before changing edge.');segmentEdge=el.dataset.edge;chooseInGroup('#segment-edge [data-edge]','edge',segmentEdge);renderLive();}));
  window.addEventListener('deviceorientation',onOrientation,true);
  setupHTest({sensorsEnabled: () => enabled, prepareAudio, beep});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)interruptActiveTrials('The app was backgrounded; active trials were discarded to prevent sensor gaps.');});
  window.addEventListener('pagehide',()=>interruptActiveTrials());
  window.setInterval(()=>{if(enabled&&orientationSeen&&!sensorFresh()){interruptActiveTrials('Sensor stream stopped; repeat the interrupted measurement.');}
    if(trunk.phase==='zeroing'&&performance.now()-trunk.zeroStarted>MAX_ZERO_MS){trunk.phase='interrupted';setWarning('Unable to zero. Hold the phone still and repeat.');}
    if(rom.phase==='zeroing'&&performance.now()-rom.zeroStarted>MAX_ZERO_MS){rom.phase='interrupted';setWarning('Unable to zero. Hold the phone still and repeat.');}
    if(screen==='info')renderDiagnostics();updatePermissionBanner();renderLive();},450);
  if('serviceWorker'in navigator&&window.isSecureContext)navigator.serviceWorker.register('./sw.js').catch(()=>{});
  renderTrunkSession();renderRecords();renderDiagnostics();renderLive();
}
wireUI();
