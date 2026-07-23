'use strict';

// ---------------------------------------------------------------------------
// Service worker de la PWA « Ma Compta ».
// Rôle : permettre le lancement hors-ligne (coquille de l'app en cache) et
// servir les fichiers statiques rapidement. Les appels aux API Google/Gemini
// (autres origines) ne sont jamais interceptés : ils passent par le réseau.
// Pensé pour le déploiement « à plat » (web/) : tout est à la racine du site.
// ---------------------------------------------------------------------------

// Version du cache : à incrémenter à chaque refonte visuelle. L'ancien cache est
// purgé à l'activation, ce qui évite de servir un mélange d'anciens et de
// nouveaux fichiers après une mise à jour importante.
const CACHE = 'macompta-mry0vtpt';

const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'css/styles.css', 'vendor/leaflet/leaflet.css',
  'assets/icon.png', 'assets/icon-192.png', 'assets/icon-256.png', 'assets/icon-180.png', 'assets/icon-32.png',
  'assets/fonts/manrope-400.woff2', 'assets/fonts/manrope-500.woff2',
  'assets/fonts/manrope-600.woff2', 'assets/fonts/manrope-700.woff2',
  'assets/fonts/sora-500.woff2', 'assets/fonts/sora-600.woff2', 'assets/fonts/sora-700.woff2',
  'vendor/chart.umd.js', 'vendor/xlsx.full.min.js', 'vendor/pdf.min.js', 'vendor/leaflet/leaflet.js',
  'js/settings.js', 'js/datepicker.js', 'js/stats.js', 'js/charts.js', 'js/import.js', 'js/pdfimport.js',
  'js/factures.js', 'js/fiscal.js', 'js/bilan.js', 'js/ai.js', 'js/connections.js',
  'js/agenda.js', 'js/mailbox.js', 'js/trajets.js', 'js/notes.js', 'js/today.js',
  'js/privacy.js', 'js/storage.js', 'js/app.js', 'js/theme.js',
  'js/google-auth-web.js', 'js/drive-store.js', 'js/api-web.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Ajout fichier par fichier : une ressource manquante ne fait pas échouer l'install.
      Promise.all(SHELL.map((u) => cache.add(u).catch(function () {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  // Autres origines (API Google/Gemini, GIS, tuiles de carte) -> réseau direct.
  if (url.origin !== self.location.origin) return;

  // Réseau d'abord (toujours la dernière version quand on est en ligne), avec
  // repli sur le cache hors-ligne. Évite de servir du vieux code après une MAJ.
  //
  // La navigation (index.html) est demandée en `cache: 'reload'` : on court-circuite
  // le cache HTTP du navigateur (que GitHub Pages autorise 10 min) pour TOUJOURS
  // recharger le HTML frais — c'est lui qui pointe vers les CSS/JS versionnés (?b=…).
  // Sans ça, un vieux index.html continuerait de référencer les anciens fichiers.
  const isNav = req.mode === 'navigate';
  const netReq = isNav ? new Request(req.url, { cache: 'reload' }) : req;
  e.respondWith(
    fetch(netReq).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(function () {});
      }
      return res;
    }).catch(() =>
      // Hors-ligne : `ignoreSearch` fait correspondre « styles.css?b=… » au fichier
      // « styles.css » mis en cache par la coquille (précache sans query).
      caches.match(req, { ignoreSearch: true }).then((c) => c || caches.match('index.html'))
    )
  );
});
