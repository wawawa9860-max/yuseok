/*
 * 현장은 통신이 끊기는 곳이 많다. 화면 자체는 캐시해 두어
 * 앱이 열리지 않는 상황을 막는다. 데이터는 캐시하지 않는다.
 */
const SHELL = 'rfcip-shell-v2';
// app.js 가 import 하는 모듈까지 전부 넣어야 한다.
// pick.js / queue.js 가 빠지면 통신이 끊긴 채로 앱을 열 때
// 모듈을 못 받아 화면이 아예 뜨지 않는다.
const FILES = [
  './', './index.html', './styles.css',
  './app.js', './pick.js', './queue.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;      // 데이터는 항상 네트워크
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
