/* GuimasCar gestao — Service Worker seguro v117
   HTML/navegação: NETWORK-FIRST. Cache é apenas fallback offline. */
const CACHE='guimas-gestao-shell-v117';
const PREFIX='guimas-gestao-shell-v';
const INDEX=new URL('./index.html',self.registration.scope).href;

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const c=await caches.open(CACHE);
    try{const r=await fetch(INDEX,{cache:'no-store'});if(r&&r.ok)await c.put(INDEX,r.clone());}catch(e){}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const ks=await caches.keys();
    await Promise.all(ks.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});

function isHtml(req,url){
  return req.mode==='navigate'||url.pathname.endsWith('/')||url.pathname.endsWith('/index.html');
}

self.addEventListener('fetch',event=>{
  const req=event.request;if(req.method!=='GET')return;
  const url=new URL(req.url);if(url.origin!==self.location.origin)return;
  if(!isHtml(req,url))return;
  event.respondWith((async()=>{
    const c=await caches.open(CACHE);
    try{
      const fresh=await fetch(req,{cache:'no-store'});
      if(fresh&&fresh.ok)await c.put(INDEX,fresh.clone());
      return fresh;
    }catch(e){
      const hit=await c.match(INDEX);if(hit)return hit;
      throw e;
    }
  })());
});
