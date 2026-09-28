const CACHE="nexttask-v9";
const ASSETS=[
  "./",
  "./index.html",
  "./style.css?v=9",
  "./app.js?v=9",
  "./manifest.json?v=9",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install",event=>{
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(cache=>cache.addAll(ASSETS))
  );
});

self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)));
    await self.clients.claim();

    const clients=await self.clients.matchAll({
      type:"window",
      includeUncontrolled:true
    });

    await Promise.all(clients.map(client=>{
      if(!client.navigate) return Promise.resolve();
      return client.navigate(client.url).catch(()=>{});
    }));
  })());
});

self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET") return;

  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);

    try{
      const response=await fetch(event.request,{cache:"no-store"});
      if(response && response.ok){
        cache.put(event.request,response.clone()).catch(()=>{});
      }
      return response;
    }catch(e){
      const cached=await caches.match(event.request);
      if(cached) return cached;

      if(event.request.mode==="navigate"){
        return (await caches.match("./index.html")) || (await caches.match("./"));
      }

      throw e;
    }
  })());
});
