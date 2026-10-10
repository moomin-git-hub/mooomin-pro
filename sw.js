/* Mo'min — service worker: ilova qobig'i oflayn ishlaydi, ma'lumot (/api) hech qachon keshlanmaydi.
   Sahifa: avval keshdan (tez ochiladi), fonda yangilanadi — yangi versiya keyingi ochilishda chiqadi. */
const VER = "momin-v3-2";
const SHELL = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon.svg"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VER).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.indexOf("momin") === 0 && k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || u.pathname.indexOf("/api/") === 0) return;
  if (r.mode === "navigate") {
    e.respondWith(caches.open(VER).then(async c => {
      const hit = await c.match("index.html");
      const net = fetch(r).then(res => { if (res && res.ok) c.put("index.html", res.clone()); return res; }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || new Response("Oflayn — internetga ulaning va qayta oching.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => {
    if (res && res.ok && res.type === "basic") { const cp = res.clone(); caches.open(VER).then(c => c.put(r, cp)); }
    return res;
  })));
});
