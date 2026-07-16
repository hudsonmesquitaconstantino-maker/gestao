var CACHE='gestao-guimas-v1';
self.addEventListener('install',function(e){self.skipWaiting()});
self.addEventListener('activate',function(e){
 e.waitUntil(caches.keys().then(function(ks){
  return Promise.all(ks.filter(function(k){return k.indexOf('gestao-guimas')===0&&k!==CACHE}).map(function(k){return caches.delete(k)}));
 }).then(function(){return self.clients.claim()}));
});
self.addEventListener('fetch',function(e){
 var req=e.request;
 if(req.method!=='GET')return;
 var url=req.url;
 if(url.indexOf('firebaseio.com')>=0||url.indexOf('googleapis.com')>=0||url.indexOf('firebaseapp.com')>=0||url.indexOf('firebasestorage')>=0)return;
 e.respondWith(
  fetch(req).then(function(res){
   if(res&&res.status===200&&(res.type==='basic'||res.type==='cors')){
    var cl=res.clone();caches.open(CACHE).then(function(c){c.put(req,cl)});
   }
   return res;
  }).catch(function(){return caches.match(req)})
 );
});
