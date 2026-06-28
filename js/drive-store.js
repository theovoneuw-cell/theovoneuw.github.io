'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Stockage de la compta CÔTÉ NAVIGATEUR (PWA), sans serveur :
//   · source de vérité = un fichier `compta.json` dans le Google Drive de
//     l'utilisateur (dossier caché `appDataFolder`, propre à l'app) ;
//   · cache hors-ligne = IndexedDB (lancement instantané + lecture sans réseau).
// Synchro PC ↔ iPhone via le même fichier Drive (dernier écrivain gagne).
// En mode Electron (PC), window.api existe : ce module ne fait rien.
// ---------------------------------------------------------------------------
(function () {
  if (window.api) return;

  const FILE_NAME = 'compta.json';
  const FIELDS = 'id,name,modifiedTime,headRevisionId';
  const FILES = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

  let meta = null;   // { id, modifiedTime, headRevisionId } du fichier Drive

  // ----- Cache local minimal (IndexedDB clé/valeur) -----
  const DB_NAME = 'macompta', STORE = 'kv', KEY = 'compta';
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    try {
      const db = await openDb();
      return await new Promise((resolve) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }
  async function idbSet(key, val) {
    try {
      const db = await openDb();
      await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (_) {}
  }

  // ----- Appels Drive authentifiés -----
  async function authFetch(url, opts) {
    const tok = await CC.gauth.token(false);   // token silencieux
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + tok }, opts.headers || {});
    return fetch(url, opts);
  }
  async function findFile() {
    const q = encodeURIComponent("name='" + FILE_NAME + "'");
    const url = FILES + '?spaces=appDataFolder&pageSize=1&fields=' + encodeURIComponent('files(' + FIELDS + ')') + '&q=' + q;
    const r = await authFetch(url);
    if (!r.ok) throw new Error('Drive (liste) ' + r.status);
    const d = await r.json();
    return (d.files && d.files[0]) || null;
  }
  async function downloadFile(id) {
    const r = await authFetch(FILES + '/' + id + '?alt=media');
    if (!r.ok) throw new Error('Drive (lecture) ' + r.status);
    return await r.text();
  }
  async function uploadNew(content) {
    const boundary = 'mc' + Math.random().toString(36).slice(2);
    const metaPart = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] });
    const body =
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + metaPart +
      '\r\n--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + content +
      '\r\n--' + boundary + '--';
    const r = await authFetch(UPLOAD + '?uploadType=multipart&fields=' + FIELDS, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: body
    });
    if (!r.ok) throw new Error('Drive (création) ' + r.status);
    return await r.json();
  }
  async function uploadUpdate(id, content) {
    const r = await authFetch(UPLOAD + '/' + id + '?uploadType=media&fields=' + FIELDS, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: content
    });
    if (!r.ok) throw new Error('Drive (mise à jour) ' + r.status);
    return await r.json();
  }

  // ----- Variante générique (par nom de fichier) pour le pense-bête -----
  const NOTES_NAME = 'notes.json';
  let notesMeta = null;
  async function findNamed(name) {
    const q = encodeURIComponent("name='" + name + "'");
    const url = FILES + '?spaces=appDataFolder&pageSize=1&fields=' + encodeURIComponent('files(' + FIELDS + ')') + '&q=' + q;
    const r = await authFetch(url);
    if (!r.ok) throw new Error('Drive (liste) ' + r.status);
    const d = await r.json();
    return (d.files && d.files[0]) || null;
  }
  async function uploadNewNamed(name, content) {
    const boundary = 'mc' + Math.random().toString(36).slice(2);
    const metaPart = JSON.stringify({ name: name, parents: ['appDataFolder'] });
    const body =
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + metaPart +
      '\r\n--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + content +
      '\r\n--' + boundary + '--';
    const r = await authFetch(UPLOAD + '?uploadType=multipart&fields=' + FIELDS, {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body
    });
    if (!r.ok) throw new Error('Drive (création) ' + r.status);
    return await r.json();
  }

  CC.cloud = {
    // Contenu du cache local uniquement (instantané, sans réseau).
    async cached() { const c = await idbGet(KEY); return c ? c.content : null; },

    // Chargement initial : cache d'abord (instantané/offline), puis Drive si connecté.
    async load() {
      const cache = await idbGet(KEY);
      if (CC.gauth.isConnected()) {
        try {
          const f = await findFile();
          if (f) {
            meta = f;
            const content = await downloadFile(f.id);
            await idbSet(KEY, { content: content, savedAt: f.modifiedTime });
            return { content: content, source: 'drive' };
          }
        } catch (_) { /* hors-ligne ou non autorisé -> on garde le cache */ }
      }
      return { content: cache ? cache.content : null, source: cache ? 'cache' : 'empty' };
    },

    // Enregistrement : cache local toujours, puis push Drive si connecté.
    async save(content) {
      await idbSet(KEY, { content: content, savedAt: new Date().toISOString() });
      if (!CC.gauth.isConnected()) return { offline: true };
      try {
        if (!meta) meta = await findFile();
        meta = meta ? await uploadUpdate(meta.id, content) : await uploadNew(content);
        return { ok: true };
      } catch (e) {
        return { offline: true, error: String(e.message || e) };
      }
    },

    // ----- Pense-bête (fichier Drive séparé) -----
    async loadNotes() {
      try {
        if (!CC.gauth.isConnected()) return { exists: false, notes: [], offline: true };
        const f = await findNamed(NOTES_NAME);
        if (!f) return { exists: false, notes: [] };
        notesMeta = f;
        const r = await authFetch(FILES + '/' + f.id + '?alt=media');
        if (!r.ok) throw new Error('Drive notes ' + r.status);
        const txt = await r.text();
        let notes = [];
        try { const d = JSON.parse(txt); notes = Array.isArray(d) ? d : (Array.isArray(d.notes) ? d.notes : []); } catch (_) {}
        return { exists: true, notes: notes };
      } catch (_) { return { exists: false, notes: [], offline: true }; }
    },
    async saveNotes(notes) {
      if (!CC.gauth.isConnected()) return { offline: true };
      const content = JSON.stringify({ notes: notes || [], savedAt: new Date().toISOString() });
      try {
        if (!notesMeta) notesMeta = await findNamed(NOTES_NAME);
        notesMeta = notesMeta ? await uploadUpdate(notesMeta.id, content) : await uploadNewNamed(NOTES_NAME, content);
        return { ok: true };
      } catch (e) { return { offline: true, error: String(e.message || e) }; }
    },

    // Tire les données depuis Drive et les applique si elles diffèrent du cache.
    // Appelé après la connexion Google et au démarrage si déjà connecté.
    async syncFromDrive(opts) {
      opts = opts || {};
      if (!CC.gauth.isConnected()) return;
      try {
        const f = await findFile();
        if (!f) {
          // Rien dans Drive encore : on y dépose l'état courant.
          if (CC.storage) await CC.cloud.save(CC.storage.serialize());
          return;
        }
        meta = f;
        const content = await downloadFile(f.id);
        const cache = await idbGet(KEY);
        if (cache && cache.content === content) return;          // déjà à jour
        await idbSet(KEY, { content: content, savedAt: f.modifiedTime });
        if (CC.storage && content) {
          try {
            CC.storage.applyData(JSON.parse(content));
            CC.state.dirty = false;
            CC.refreshYears && CC.refreshYears();
            CC.renderSettings && CC.renderSettings();
            CC.render && CC.render();
            CC.updateDirtyUI && CC.updateDirtyUI();
            CC.renderToday && CC.renderToday();
            if (!opts.silent && CC.toast) CC.toast('Données synchronisées depuis Google Drive ✓', 'ok');
          } catch (_) {}
        }
      } catch (_) { /* silencieux : on reste sur le cache */ }
    }
  };
})();
