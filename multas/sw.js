/* Multas da Frota — service worker próprio (escopo /gestao/multas/)
   Página: rede primeiro, cache só se estiver sem internet. */
const CACHE = 'guimas-multas-v18';
const PAGE = new URL('./index.html', self.registration.scope).href;
self.addEventListener('install', e => e.waitUntil((async () => {
  const c = await caches.open(CACHE);
  try{ const r = await fetch(PAGE, {cache: 'no-store'}); if(r.ok) await c.put(PAGE, r); }catch(err){}
  await self.skipWaiting();
})()));
self.addEventListener('activate', e => e.waitUntil((async () => {
  for(const k of await caches.keys()) if(k.startsWith('guimas-multas-v') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  const nav = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  if(!nav) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try{ const r = await fetch(req, {cache: 'no-store'}); if(r && r.ok) await c.put(PAGE, r.clone()); return r; }
    catch(err){ const hit = await c.match(PAGE); if(hit) return hit; throw err; }
  })());
});
