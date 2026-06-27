'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Connexion Google CÔTÉ NAVIGATEUR (PWA), sans serveur ni secret.
// Utilise Google Identity Services (GIS) : flux « token client » pour app web.
//  - L'identifiant client (Client ID) est PUBLIC (pas de secret nécessaire).
//  - On obtient un access token court (~1 h), rafraîchi silencieusement.
//  - Mêmes droits que l'app PC : Gmail, Agenda, et Drive (appDataFolder).
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
  let tokenClient = null;
  let token = '';            // access token courant
  let tokenExp = 0;          // expiration (ms epoch)
  let pending = null;        // { resolve, reject } de la demande en cours

  function clientId() { return (localStorage.getItem('googleClientId') || '').trim(); }

  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    if (gisLoading) return gisLoading;
    gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_SRC; s.async = true; s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => { gisLoading = null; reject(new Error('Google Sign-In injoignable (connexion internet requise).')); };
      document.head.appendChild(s);
    });
    return gisLoading;
  }

  async function ensureClient() {
    const id = clientId();
    if (!id) throw new Error('Renseigne ton identifiant Google (Client ID) dans Paramètres → Connexions.');
    await loadGis();
    if (!tokenClient || tokenClient.__id !== id) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: id,
        scope: SCOPES,
        callback: (resp) => {
          if (!pending) return;
          if (resp && resp.access_token) {
            token = resp.access_token;
            tokenExp = Date.now() + (((resp.expires_in || 3600) - 60) * 1000);
            localStorage.setItem('googleConnected', '1');
            pending.resolve(token);
          } else {
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
      ensureClient().then((tc) => {
        pending = { resolve, reject };
        try { tc.requestAccessToken({ prompt: prompt }); }
        catch (e) { pending = null; reject(e); }
      }).catch(reject);
    });
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
    async connect() {
      const t = await request('consent');
      return { ok: !!t };
    },

    disconnect() {
      try {
        if (token && window.google && window.google.accounts && window.google.accounts.oauth2) {
          window.google.accounts.oauth2.revoke(token, function () {});
        }
      } catch (_) {}
      token = ''; tokenExp = 0;
      localStorage.removeItem('googleConnected');
      return { ok: true };
    }
  };
})();
