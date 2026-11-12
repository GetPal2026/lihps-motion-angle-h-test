/* Offline asset cache. Bump cache version whenever an application file changes. */
const CACHE_NAME='lihps-motion-h-test-static-v0.3.0';
const CORE=['./','./index.html','./styles.css','./app.js','./math.js','./h-test.js','./h-math.js','./manifest.webmanifest','./icons/icon-180.png','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(Promise.all([
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('lihps-motion-h-test-')&&k!==CACHE_NAME).map(k=>caches.delete(k)))),
  self.clients.claim()
]));});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(!url.href.startsWith(self.registration.scope))return;
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}return response;}).catch(()=>caches.open(CACHE_NAME).then(cache=>cache.match('./index.html'))));
    return;
  }
  event.respondWith(caches.open(CACHE_NAME).then(cache=>cache.match(request)).then(hit=>hit||fetch(request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}return response;
  })));
});
