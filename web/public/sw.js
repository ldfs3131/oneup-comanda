/* ONE UP Comanda — service worker do app instalado.
 * Não guarda telas nem dados (o sistema sempre mostra a informação do servidor, ao vivo).
 * Só mostra um aviso amigável quando o celular está sem internet. */
const OFFLINE = '/offline.html';
self.addEventListener('install', (e) => { e.waitUntil(caches.open('oneup-offline-v1').then((c) => c.add(OFFLINE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return; // API, imagens e arquivos: direto da rede
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
