/* Manuscrito — Service Worker
   Faz o app abrir offline. Bump a versão a cada deploy pra invalidar o cache antigo. */
const CACHE = "manuscrito-v7";

// "casco" do app (mesma origem) — pré-cacheado na instalação
const SHELL = [
  "/",
  "/index.html",
  "/app.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

// origens estáticas de terceiros (fontes + lib) — cacheadas em tempo de execução
const RUNTIME_ORIGINS = [
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://cdn.jsdelivr.net",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // escritas (POST/PATCH/DELETE) nunca são cacheadas

  const url = new URL(req.url);

  // Navegação: tenta a rede; se offline, cai pro index.html cacheado (a SPA assume daí)
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/index.html")));
    return;
  }

  // Mesma origem (casco do app): NETWORK-FIRST.
  // Online, sempre pega a versão mais nova da rede (acaba o "mudei o código e a tela não muda").
  // Offline, cai pro cache. O cache serve só como rede de segurança, não como fonte principal.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Fontes + lib (terceiros estáticos): stale-while-revalidate
  if (RUNTIME_ORIGINS.includes(url.origin)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Resto (ex.: API do Supabase): rede direta. Offline, o app usa o espelho local.
});
