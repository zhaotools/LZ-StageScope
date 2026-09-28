const CACHE = "lz-stagescope-v1.3.3";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=1.3.0",
  "./app.js?v=1.3.3",
  "./member-auth.js?v=1.1.4",
  "./member-config.js?v=1.0.19",
  "./manifest.webmanifest",
  "./favicon.ico",
  "./icons/favicon-v3.ico",
  "./icons/favicon-32-v3.png",
  "./icons/safari-pinned-tab.svg",
  "./icons/icon-180.png",
  "./icons/icon-192.png?v=1.1.0",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
      return response;
    }
    const cached = await cache.match(request);
    return cached || response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function navigationFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) return response;
  } catch (error) {
    // Continue with a route-safe cached application shell while offline.
  }
  const requestUrl = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);
  const isShellLocation = requestUrl.pathname === scopeUrl.pathname
    || requestUrl.pathname === new URL("./index.html", scopeUrl).pathname;
  if (isShellLocation) return caches.match(new URL("./index.html", scopeUrl));

  const relativePath = requestUrl.pathname.startsWith(scopeUrl.pathname)
    ? requestUrl.pathname.slice(scopeUrl.pathname.length).replace(/\/$/, "")
    : "";
  const route = relativePath === "watchlist"
    ? "/watchlist"
      : /^[a-z0-9-]+\/(overview|weekly|daily|dca|fundamentals|methodology)$/.test(relativePath)
      ? `/${relativePath}`
      : "/watchlist";
  const shellUrl = new URL("./", scopeUrl);
  shellUrl.searchParams.set("route", route);
  return Response.redirect(shellUrl, 302);
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(navigationFirst(event.request));
    return;
  }
  if (url.pathname.includes("/data/")) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  if (/\.(?:js|css)$/.test(url.pathname)) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
