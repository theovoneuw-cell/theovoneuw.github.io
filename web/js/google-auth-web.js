'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Connexion Google CÔTÉ NAVIGATEUR (PWA), sans serveur ni secret.
// Utilise Google Identity Services (GIS) : flux « token client » pour app web.
//  - L'identifiant client (Client ID) est PUBLIC (pas de secret nécessaire).
//  - On obtient un access token court (~1 h), rafraîchi silencieusement.
//  - Mêmes droits que l'app PC : Gmail, Agenda, et Drive (appDataFolder).
//
// IMPORTANT (Safari / iPhone) : la pop-up de connexion DOIT être ouverte de façon
// quasi synchrone après le clic. On précharge donc la lib GIS dès l'ouverture de
// l'app, et `requestAccessToken` est appelé directement (sans attente réseau),
// sinon Safari bloque la fenêtre (« Popup window closed »).
// En mode Electron (PC), window.api existe déjà : ce module ne fait rien.
// ---------------------------------------------------------------------------
(function () {
  if (window.api) return;   // app de bureau : pont natif déjà présent

  const SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive.appdata',
    'openid', 'email'
  ].join(' ');
  const GIS_SRC = 'https://accounts.google.com/gsi/client';

  let gisLoading = null;     // Promise de chargement de la lib GIS
  let gisReady = false;      // lib GIS disponible ?
  let tokenClient = null;
  let token = '';            // access token courant
  let tokenExp = 0;          // expiration (ms epoch)
  let pending = null;        // { resolve, reject } de la demande en cours

  function clientId() { return (localStorage.getItem('googleClientId') || '').trim(); }

  // Persistance du jeton : Safari/iPhone ne sait pas rafraîchir en silence
  // (protection anti-traçage). On garde donc le jeton valide (~1 h) en local
  // pour ne PAS redemander l'autorisation à chaque réouverture, et pour que la
  // synchro Drive (compta + pense-bête) reparte toute seule.
  function persistToken() {
    try { localStorage.setItem('googleToken', token); localStorage.setItem('googleTokenExp', String(tokenExp)); } catch (_) {}
  }
  function restoreToken() {
    try {
      const t = localStorage.getItem('googleToken');
      const e = parseInt(localStorage.getItem('googleTokenExp') || '0', 10);
      if (t && e > Date.now() + 5000) { token = t; tokenExp = e; }
    } catch (_) {}
  }
  restoreToken();

  // ------------------------------------------------------------------------
  // Renouvellement silencieux du jeton.
  // Google plafonne les jetons web à ~1 h et NE fournit pas de "refresh token"
  // sans serveur : on ne peut donc pas tenir 24 h d'un seul jeton. À la place,
  // tant que l'app est ouverte/au premier plan, on redemande silencieusement un
  // nouveau jeton AVANT l'expiration (prompt:'' = sans aucune fenêtre si déjà
  // autorisé). Sur iOS le silencieux peut échouer (anti-traçage) → on retombe
  // alors sur une reconnexion au prochain geste. Après CHAQUE jeton obtenu, on
  // recharge le pense-bête et la compta (plus besoin de fermer/rouvrir l'app).
  // ------------------------------------------------------------------------
  let renewT = null;
  function afterToken() {
    try { if (CC.cloud && CC.cloud.syncFromDrive) CC.cloud.syncFromDrive({ silent: true }); } catch (_) {}
    try { if (CC.notes && CC.notes.pull) CC.notes.pull(); } catch (_) {}
    try { if (CC.updateMailBadge) CC.updateMailBadge(); } catch (_) {}
  }
  function silentRenew() {
    if (!clientId() || localStorage.getItem('googleConnected') !== '1') return;
    // request('') déclenche le callback ci-dessus (token + scheduleRenew + afterToken).
    request('').catch(function () { /* iOS peut bloquer le renouvellement silencieux */ });
  }
  function scheduleRenew() {
    clearTimeout(renewT);
    if (!tokenExp) return;
    // ~2 min avant l'expiration (au minimum dans 15 s).
    const delay = Math.max(15000, tokenExp - Date.now() - 120000);
    renewT = setTimeout(silentRenew, delay);
  }
  // Au premier plan : si le jeton est mort ou proche de l'expiration, on le renouvelle.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (localStorage.getItem('googleConnected') !== '1') return;
    if (!token || Date.now() > tokenExp - 120000) silentRenew();
  });
  if (token && Date.now() < tokenExp) scheduleRenew();   // jeton restauré encore valide

  function loadGis() {
    if (gisReady || (window.google && window.google.accounts && window.google.accounts.oauth2)) {
      gisReady = true; return Promise.resolve();
    }
    if (gisLoading) return gisLoading;
    gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_SRC; s.async = true; s.defer = true;
      s.onload = () => { gisReady = true; resolve(); };
      s.onerror = () => { gisLoading = null; reject(new Error('Google Sign-In injoignable (connexion internet requise).')); };
      document.head.appendChild(s);
    });
    return gisLoading;
  }

  // Crée (ou réutilise) le token client. Synchrone : suppose GIS déjà chargé.
  function makeClient() {
    const id = clientId();
    if (!id) throw new Error('Renseigne ton identifiant Google (Client ID) dans Paramètres → Connexions.');
    if (!gisReady) throw new Error('not-ready');
    if (!tokenClient || tokenClient.__id !== id) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: id,
        scope: SCOPES,
        callback: (resp) => {
          if (resp && resp.access_token) {
            token = resp.access_token;
            tokenExp = Date.now() + (((resp.expires_in || 3600) - 60) * 1000);
            localStorage.setItem('googleConnected', '1');
            persistToken();
            scheduleRenew();   // programme le prochain renouvellement silencieux
            afterToken();      // re-synchro Drive + pense-bête (sans fermer/rouvrir)
            if (pending) pending.resolve(token);
          } else if (pending) {
            pending.reject(new Error((resp && resp.error) || 'Connexion Google refusée.'));
          }
          pending = null;
        },
        error_callback: (err) => {
          if (!pending) return;
          pending.reject(new Error((err && err.message) || 'Connexion Google annulée.'));
          pending = null;
        }
      });
      tokenClient.__id = id;
    }
    return tokenClient;
  }

  // prompt: '' = silencieux (pas d'UI si déjà autorisé) ; 'consent' = interactif.
  function request(prompt) {
    return new Promise((resolve, reject) => {
      if (!clientId()) { reject(new Error('Renseigne ton identifiant Google (Client ID) dans Paramètres → Connexions.')); return; }
      // Chemin rapide : GIS déjà prêt -> ouverture quasi synchrone (Safari OK).
      if (gisReady) {
        try { const tc = makeClient(); pending = { resolve, reject }; tc.requestAccessToken({ prompt: prompt }); }
        catch (e) { reject(e); }
        return;
      }
      // GIS pas encore chargé : on charge puis on demande (peut perdre le geste).
      loadGis().then(() => {
        try { const tc = makeClient(); pending = { resolve, reject }; tc.requestAccessToken({ prompt: prompt }); }
        catch (e) { reject(e); }
      }).catch(reject);
    });
  }

  // Connexion idempotente : si une pop-up est déjà en cours, on renvoie la même
  // promesse (évite d'ouvrir deux fenêtres quand l'app appelle aussi connect()).
  let inflight = null;
  function startConnect() {
    if (inflight) return inflight;
    inflight = request('consent').then(
      (t) => { inflight = null; return { ok: !!t }; },
      (e) => { inflight = null; throw e; }
    );
    return inflight;
  }

  CC.gauth = {
    isConnected() { return localStorage.getItem('googleConnected') === '1'; },

    // Renvoie un access token valide. interactive=true autorise l'ouverture du
    // popup de consentement (à n'utiliser que suite à un clic utilisateur).
    async token(interactive) {
      if (token && Date.now() < tokenExp) return token;
      try { return await request(''); }
      catch (e) {
        if (interactive) return await request('consent');
        throw e;
      }
    },

    // Connexion explicite (clic sur « Connecter Google »).
    connect() { return startConnect(); },

    disconnect() {
      try {
        if (token && window.google && window.google.accounts && window.google.accounts.oauth2) {
          window.google.accounts.oauth2.revoke(token, function () {});
        }
      } catch (_) {}
      token = ''; tokenExp = 0;
      localStorage.removeItem('googleConnected');
      localStorage.removeItem('googleToken');
      localStorage.removeItem('googleTokenExp');
      return { ok: true };
    }
  };

  // Préchargement : la lib GIS est prête bien avant que l'utilisateur clique,
  // pour que la pop-up s'ouvre sans accroc (indispensable sur Safari/iPhone).
  loadGis().catch(function () {});

  // CLÉ pour Safari/iPhone : on ouvre la pop-up de connexion DIRECTEMENT dans le
  // geste de clic (phase de capture, avant le gestionnaire asynchrone de l'app).
  // Safari bloque toute fenêtre ouverte après un `await` → « Popup window closed ».
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('#btnConnectGoogle');
    if (!btn) return;
    // Récupère un Client ID éventuellement saisi mais pas encore enregistré.
    const f = document.getElementById('setGoogleClientId');
    if (f && f.value.trim()) localStorage.setItem('googleClientId', f.value.trim());
    if (!clientId()) return;                  // pas d'ID : on laisse l'app prévenir
    startConnect().catch(function () {});      // ouvre la pop-up MAINTENANT (dans le geste)
  }, true);
})();
