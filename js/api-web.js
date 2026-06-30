'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Pont `window.api` pour la version NAVIGATEUR / PWA (iPhone).
// Recrée, côté client, ce que le process Electron faisait : appels directs aux
// API Google (Gmail, Agenda, Drive) avec le token de CC.gauth, IA Gemini,
// itinéraires, et stockage via CC.cloud (Drive + IndexedDB).
// En mode Electron (PC), window.api est déjà fourni par preload.js → on ne fait
// rien (ce fichier ne s'active que sur le web).
// ---------------------------------------------------------------------------
(function () {
  if (window.api) return;

  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const GCAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
  const GEMINI_FALLBACKS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-latest'];
  const UA_NONE = {};   // (pas d'User-Agent custom en navigateur : interdit)

  // ---- localStorage helpers (clés / réglages, pas la compta) ----
  function lsGet(k) { return (localStorage.getItem(k) || '').trim(); }
  function lsSet(k, v) { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, String(v)); }

  // ---- Base64 / Base64url (UTF-8 correct dans le navigateur) ----
  function b64urlDecode(data) {
    if (!data) return '';
    try {
      const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch (_) { return ''; }
  }
  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = ''; const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function encHeader(s) {
    s = s || '';
    return /[^\x00-\x7F]/.test(s) ? '=?UTF-8?B?' + btoa(unescape(encodeURIComponent(s))) + '?=' : s;
  }

  // ---- Appels Google authentifiés ----
  async function tok() { return await CC.gauth.token(false); }
  async function gget(url) {
    let t; try { t = await tok(); } catch (_) { return { __error: "Connecte ton compte Google (Paramètres → Connexions)." }; }
    let res;
    try { res = await fetch(url, { headers: { Authorization: 'Bearer ' + t } }); }
    catch (_) { return { __error: 'Pas de connexion internet.' }; }
    if (res.status === 401 || res.status === 403) return { __error: "Autorisation Google insuffisante : reconnecte ton compte." };
    if (!res.ok) { let m = res.status; try { const d = await res.json(); m = (d.error && d.error.message) || res.status; } catch (_) {} return { __error: 'Erreur Google (' + m + ').' }; }
    try { return await res.json(); } catch (_) { return { __error: 'Réponse Google illisible.' }; }
  }
  async function gsend(method, url, bodyObj, raw) {
    let t; try { t = await tok(); } catch (_) { return { __error: "Connecte ton compte Google (Paramètres → Connexions)." }; }
    const headers = { Authorization: 'Bearer ' + t };
    let body;
    if (raw) { body = bodyObj; Object.assign(headers, raw); }
    else if (bodyObj !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(bodyObj); }
    let res;
    try { res = await fetch(url, { method: method, headers: headers, body: body }); }
    catch (_) { return { __error: 'Pas de connexion internet.' }; }
    if (res.status === 401 || res.status === 403) return { __error: "Autorisation Google insuffisante : reconnecte ton compte." };
    if (!res.ok && res.status !== 204) { let m = res.status; try { const d = await res.json(); m = (d.error && d.error.message) || res.status; } catch (_) {} return { __error: 'Opération impossible (' + m + ').' }; }
    if (res.status === 204) return {};
    try { return await res.json(); } catch (_) { return {}; }
  }
  function header(payload, name) {
    const hs = (payload && payload.headers) || [];
    const h = hs.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  }

  // ====================== GMAIL ======================
  async function listFolder(dossier, maxResults) {
    const max = maxResults || 25;
    let ids = [];
    if (dossier === 'brouillons') {
      const data = await gget(GMAIL + '/drafts?maxResults=' + max);
      if (data.__error) return { error: data.__error };
      ids = (data.drafts || []).map((d) => ({ id: d.message.id, draftId: d.id }));
    } else {
      const labelIds = dossier === 'envoyes' ? 'SENT' : 'INBOX';
      const q = dossier === 'principal' ? '&q=' + encodeURIComponent('category:primary') : '';
      const data = await gget(GMAIL + '/messages?labelIds=' + labelIds + '&maxResults=' + max + q);
      if (data.__error) return { error: data.__error };
      ids = (data.messages || []).map((m) => ({ id: m.id }));
    }
    const metas = await Promise.all(ids.map(async (it) => {
      const m = await gget(GMAIL + '/messages/' + it.id + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date');
      if (m.__error) return null;
      const labels = m.labelIds || [];
      return {
        id: it.id, draftId: it.draftId || '',
        de: header(m.payload, 'From'), a: header(m.payload, 'To'),
        sujet: header(m.payload, 'Subject') || '(sans objet)',
        date: header(m.payload, 'Date'),
        dateMs: m.internalDate ? Number(m.internalDate) : 0,
        apercu: m.snippet || '',
        nonLu: labels.indexOf('UNREAD') !== -1
      };
    }));
    return { messages: metas.filter(Boolean).sort((a, b) => b.dateMs - a.dateMs) };
  }
  function walkParts(payload, acc) {
    if (!payload) return;
    const mime = payload.mimeType || '';
    const body = payload.body || {};
    if (mime === 'text/plain' && body.data && !body.attachmentId) acc.text += b64urlDecode(body.data);
    else if (mime === 'text/html' && body.data && !body.attachmentId) acc.html += b64urlDecode(body.data);
    else if (body.attachmentId || payload.filename) {
      const cid = (header(payload, 'Content-ID') || '').replace(/^<|>$/g, '');
      const disp = (header(payload, 'Content-Disposition') || '').toLowerCase();
      acc.atts.push({
        attachmentId: body.attachmentId || '',
        filename: payload.filename || cid || 'piece-jointe',
        mimeType: mime || 'application/octet-stream',
        size: body.size || 0,
        contentId: cid,
        inline: /^\s*inline/.test(disp) || (!!cid && !/^\s*attachment/.test(disp))
      });
    }
    (payload.parts || []).forEach((p) => walkParts(p, acc));
  }
  // base64url -> octets bruts (pour Blob de pièce jointe)
  function b64urlToBytes(data) {
    const bin = atob(String(data || '').replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  function buildRaw(p) {
    const head = [];
    head.push('To: ' + (p.to || ''));
    if (p.cc) head.push('Cc: ' + p.cc);
    if (p.bcc) head.push('Bcc: ' + p.bcc);
    head.push('Subject: ' + encHeader(p.subject || ''));
    head.push('MIME-Version: 1.0');
    if (p.inReplyTo) { head.push('In-Reply-To: ' + p.inReplyTo); head.push('References: ' + p.inReplyTo); }
    const atts = p.attachments || [];
    if (!atts.length) {
      head.push('Content-Type: text/plain; charset="UTF-8"');
      head.push('Content-Transfer-Encoding: base64');
      return b64urlEncode(head.join('\r\n') + '\r\n\r\n' + btoa(unescape(encodeURIComponent(p.body || ''))));
    }
    const boundary = 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    head.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
    let msg = head.join('\r\n') + '\r\n\r\n';
    msg += '--' + boundary + '\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
    msg += btoa(unescape(encodeURIComponent(p.body || ''))) + '\r\n';
    atts.forEach((a) => {
      const name = encHeader(a.filename || 'piece-jointe');
      const data = (String(a.dataB64 || '').match(/.{1,76}/g) || []).join('\r\n');
      msg += '--' + boundary + '\r\n';
      msg += 'Content-Type: ' + (a.mimeType || 'application/octet-stream') + '; name="' + name + '"\r\n';
      msg += 'Content-Transfer-Encoding: base64\r\n';
      msg += 'Content-Disposition: attachment; filename="' + name + '"\r\n\r\n';
      msg += data + '\r\n';
    });
    msg += '--' + boundary + '--';
    return b64urlEncode(msg);
  }
  function parseOneAddr(a) {
    const m = a.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
    const e = a.trim().replace(/^"|"$/g, '');
    return /@/.test(e) ? { name: '', email: e.toLowerCase() } : null;
  }
  function parseAddrList(s) { return String(s || '').split(',').map((x) => x.trim()).filter(Boolean).map(parseOneAddr).filter(Boolean); }

  // ====================== GEMINI ======================
  async function geminiGenerate(opts) {
    const apiKey = lsGet('geminiKey');
    if (!apiKey) return { error: 'Clé Gemini manquante. Renseigne-la dans Paramètres → Connexions & IA.' };
    const contents = Array.isArray(opts.messages) && opts.messages.length
      ? opts.messages.map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text || '') }] }))
      : [{ role: 'user', parts: [{ text: opts.prompt || '' }] }];
    const body = {
      contents: contents,
      generationConfig: { temperature: opts.temperature != null ? opts.temperature : 0.7 }
    };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    const wanted = (opts.model || '').trim();
    const models = [wanted].concat(GEMINI_FALLBACKS).filter((m, i, a) => m && a.indexOf(m) === i);
    let quotaErr = '', lastErr = 'Aucun modèle Gemini disponible.';
    for (const model of models) {
      let res, data = null;
      try {
        res = await fetch(GEMINI + '/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
      } catch (_) { return { error: 'Pas de connexion internet ou service Gemini injoignable.' }; }
      try { data = await res.json(); } catch (_) {}
      const apiMsg = data && data.error && data.error.message;
      if (res.ok) {
        const cand = data && data.candidates && data.candidates[0];
        const parts = cand && cand.content && cand.content.parts;
        const text = parts ? parts.map((p) => p.text || '').join('').trim() : '';
        if (text) return { text: text, model: model };
        const block = data && data.promptFeedback && data.promptFeedback.blockReason;
        return { error: block ? ('Contenu bloqué par Gemini (' + block + ').') : 'Réponse vide de Gemini.' };
      }
      if (res.status === 404 || /not found|not supported|unsupported/i.test(apiMsg || '')) { lastErr = 'Modèle indisponible (' + (apiMsg || '404') + ').'; continue; }
      if (res.status === 429) { quotaErr = apiMsg || 'Quota épuisé.'; lastErr = 'Quota Gemini atteint : ' + quotaErr; continue; }
      if (res.status === 400) return { error: 'Requête refusée par Gemini : ' + (apiMsg || 'clé peut-être invalide.') };
      if (res.status === 403) return { error: 'Accès refusé (403) : ' + (apiMsg || 'clé invalide ou API non activée.') };
      return { error: 'Erreur Gemini ' + res.status + ' : ' + (apiMsg || 'inconnue') };
    }
    if (quotaErr) return { error: 'Quota gratuit Gemini épuisé.\n\nDétail : ' + quotaErr };
    return { error: lastErr };
  }

  // ====================== ROUTES ======================
  async function geocode(q) {
    q = (q || '').trim();
    if (q.length < 3) return { results: [] };
    let res;
    try { res = await fetch('https://api-adresse.data.gouv.fr/search/?limit=6&autocomplete=1&q=' + encodeURIComponent(q)); }
    catch (_) { return { error: "Pas de connexion internet (géocodage injoignable)." }; }
    if (!res.ok) return { error: "Service d'adresses indisponible (" + res.status + ').' };
    let data; try { data = await res.json(); } catch (_) { return { error: 'Réponse adresse illisible.' }; }
    const results = ((data && data.features) || []).map((f) => {
      const c = (f.geometry && f.geometry.coordinates) || []; const p = f.properties || {};
      return { label: p.label || '', city: p.city || '', context: p.context || '', lon: c[0], lat: c[1] };
    }).filter((r) => r.lat != null && r.lon != null);
    return { results: results };
  }
  async function route(from, to) {
    if (!from || !to || from.lat == null || to.lat == null) return { error: 'Coordonnées manquantes.' };
    const coords = from.lon + ',' + from.lat + ';' + to.lon + ',' + to.lat;
    let res;
    try { res = await fetch('https://router.project-osrm.org/route/v1/driving/' + coords + '?overview=full&geometries=geojson'); }
    catch (_) { return { error: "Pas de connexion internet (itinéraire injoignable)." }; }
    if (!res.ok) return { error: "Service d'itinéraire indisponible (" + res.status + ').' };
    let data; try { data = await res.json(); } catch (_) { return { error: 'Réponse itinéraire illisible.' }; }
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) return { error: 'Aucun itinéraire trouvé entre ces deux points.' };
    const r = data.routes[0];
    return { distance: r.distance, duration: r.duration, geometry: (r.geometry && r.geometry.coordinates) || [] };
  }
  function pickCost(costs) {
    if (!costs || typeof costs !== 'object') return null;
    const order = ['cash', 'tag', 'licensePlate', 'creditCard', 'prepaidCard', 'minimumTollCost'];
    for (const k of order) { const v = costs[k]; if (typeof v === 'number' && !isNaN(v)) return v; }
    return null;
  }
  async function tolls(payload) {
    const key = lsGet('tollguruKey');
    if (!key) return { error: 'no-key' };
    const from = payload.from, to = payload.to;
    if (!from || !to || from.lat == null || to.lat == null) return { error: 'Coordonnées manquantes.' };
    let res, data = null;
    try {
      res = await fetch('https://apis.tollguru.com/toll/v2/origin-destination-waypoints', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ from: { lat: from.lat, lng: from.lon }, to: { lat: to.lat, lng: to.lon }, serviceProvider: 'tollguru', vehicle: { type: payload.vehicleType || '2AxlesAuto' } })
      });
    } catch (_) { return { error: 'Péages indisponibles (service injoignable ou bloqué par le navigateur).' }; }
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const msg = (data && (data.message || (data.error && (data.error.message || data.error)))) || ('Erreur ' + res.status);
      if (res.status === 401 || res.status === 403) return { error: 'Clé TollGuru refusée (' + msg + ').' };
      return { error: 'Péages indisponibles : ' + msg };
    }
    const r = (data && (data.route || (data.routes && data.routes[0]))) || null;
    if (!r) return { error: 'Réponse péages inattendue.' };
    const costs = r.costs || {}; const cost = pickCost(costs);
    return { cost: cost || 0, currency: costs.currency || 'EUR', hasTolls: r.hasTolls != null ? !!r.hasTolls : (cost != null && cost > 0) };
  }

  // ====================== PRIVACY (code PIN, haché en local) ======================
  async function sha256(str) {
    try { const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''); }
    catch (_) { return 'x' + str.length; }
  }

  // ---- Téléchargement d'un fichier généré côté client ----
  function download(filename, content, mime) {
    try {
      const blob = new Blob([content], { type: mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
      return true;
    } catch (_) { return false; }
  }
  function pickFile(accept) {
    return new Promise((resolve) => {
      const inp = document.createElement('input'); inp.type = 'file'; if (accept) inp.accept = accept;
      inp.onchange = () => resolve(inp.files && inp.files[0] ? inp.files[0] : null);
      inp.click();
    });
  }
  function fileToB64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = reject; fr.readAsDataURL(file);
    });
  }

  // ====================== window.api (web) ======================
  window.api = {
    // ---- Données (Drive + cache) ----
    async startup() {
      const content = await CC.cloud.cached();
      // Rafraîchit depuis Drive en arrière-plan (sans bloquer le démarrage).
      setTimeout(() => { CC.cloud.syncFromDrive({ silent: true }); }, 400);
      return { content: content, filePath: content ? 'Google Drive' : null, offline: false, privacyStartup: lsGet('privacyStartup') === '1' };
    },
    async save(content) {
      const r = await CC.cloud.save(content);
      if (r && r.error) return { filePath: 'appareil (hors-ligne)' };   // gardé en cache, pas une erreur bloquante
      return { filePath: r && r.offline ? 'appareil (hors-ligne)' : 'Google Drive' };
    },
    async open() {
      const f = await pickFile('.json,.compta,application/json');
      if (!f) return { canceled: true };
      try { return { content: await f.text(), filePath: f.name }; }
      catch (e) { return { error: String(e.message || e) }; }
    },
    async read() { return { error: 'Indisponible sur le web.' }; },
    setFile() {}, setDirty() {},
    ddCheck() { return Promise.resolve({ available: false }); },
    forceClose() { try { window.close(); } catch (_) {} return Promise.resolve({ ok: true }); },

    // ---- Récupération auto (cache IndexedDB déjà géré par CC.cloud) ----
    recoveryWrite() {}, recoveryClear() {}, recoveryRead() { return Promise.resolve({}); },

    // ---- Import / export (côté navigateur) ----
    async importExcel() {
      const f = await pickFile('.xlsx,.xls,.csv');
      if (!f) return { canceled: true };
      try { return { base64: await fileToB64(f) }; }
      catch (e) { return { error: String(e.message || e) }; }
    },
    exportCsv(csv) { download('export-compta.csv', '﻿' + csv, 'text/csv;charset=utf-8'); return Promise.resolve({ filePath: 'export-compta.csv' }); },
    exportPdf() { return Promise.resolve({ canceled: true }); },
    exportBilanPdf(payload) {
      // Ouvre une page imprimable : « Partager → Imprimer/Enregistrer en PDF » sur iPhone.
      try {
        const w = window.open('', '_blank');
        if (!w) return Promise.resolve({ error: 'Fenêtre bloquée par le navigateur.' });
        w.document.write((payload && payload.html) || '<p>Rien à imprimer.</p>');
        w.document.close(); w.focus(); setTimeout(() => { try { w.print(); } catch (_) {} }, 300);
        return Promise.resolve({ filePath: (payload && payload.defaultName) || 'bilan.pdf' });
      } catch (e) { return Promise.resolve({ error: String(e.message || e) }); }
    },

    // ---- Dialogues / liens / pièces jointes ----
    openUrl(url) { try { window.open(url, '_blank', 'noopener'); } catch (_) {} return Promise.resolve({ ok: true }); },
    openPath() { return Promise.resolve({ error: "Les pièces jointes locales ne sont pas accessibles sur l'iPhone." }); },
    confirmUnsaved() { return Promise.resolve({ response: 0 }); },
    message() { return Promise.resolve({ response: 0 }); },

    // ---- Secrets / clés (stockés en local sur l'appareil) ----
    secrets: {
      available() { return Promise.resolve({ available: true }); },
      set(name, value) { lsSet(name, value); return Promise.resolve({ ok: true }); },
      status() {
        return Promise.resolve({
          available: true,
          geminiKey: !!lsGet('geminiKey'),
          tollguruKey: !!lsGet('tollguruKey'),
          googleClientId: !!lsGet('googleClientId'),
          googleClientSecret: true,                 // non requis sur le web (PKCE public)
          googleConnected: CC.gauth.isConnected()
        });
      }
    },

    // ---- IA (Gemini) ----
    ai: {
      generate(opts) { return geminiGenerate(opts || {}); },
      test() { return geminiGenerate({ prompt: 'Réponds juste OK.', temperature: 0 }); }
    },

    // ---- Google Agenda ----
    gcal: {
      async connect() {
        try { const r = await CC.gauth.connect(); await CC.cloud.syncFromDrive({ silent: false }); return r; }
        catch (e) { return { error: String(e.message || e) }; }
      },
      disconnect() { return Promise.resolve(CC.gauth.disconnect()); },
      async events(range) {
        const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin: range.timeMin, timeMax: range.timeMax, maxResults: String(range.maxResults || 25) });
        const data = await gget(GCAL + '?' + params.toString());
        if (data.__error) return { error: data.__error };
        const events = (data.items || []).map((e) => ({
          id: e.id, titre: e.summary || '(sans titre)', lieu: e.location || '', description: e.description || '',
          couleur: e.colorId || '', lien: e.htmlLink || '',
          debut: (e.start && (e.start.dateTime || e.start.date)) || '',
          fin: (e.end && (e.end.dateTime || e.end.date)) || '',
          journee: !!(e.start && e.start.date && !e.start.dateTime)
        }));
        return { events: events };
      },
      async create(event) {
        const r = await gsend('POST', GCAL, event);
        if (r.__error) return { error: r.__error };
        return { ok: true, id: r.id };
      },
      async update(payload) {
        const o = payload || {};
        if (!o.id) return { error: 'Événement manquant.' };
        const r = await gsend('PATCH', GCAL + '/' + encodeURIComponent(o.id), o.event);
        if (r.__error) return { error: r.__error };
        return { ok: true, id: r.id };
      },
      async remove(id) {
        if (!id) return { error: 'Événement manquant.' };
        const r = await gsend('DELETE', GCAL + '/' + encodeURIComponent(id), undefined);
        if (r.__error) return { error: r.__error };
        return { ok: true };
      }
    },

    // ---- Itinéraires ----
    routes: {
      geocode(q) { return geocode(q); },
      route(payload) { return route(payload.from, payload.to); },
      tolls(payload) { return tolls(payload); }
    },

    // ---- Mode discret (code PIN local) ----
    privacy: {
      status() { return Promise.resolve({ hasPin: !!lsGet('privacyPin'), startup: lsGet('privacyStartup') === '1' }); },
      async setPin(pin) {
        pin = (pin || '').trim();
        if (!pin) return { error: 'Code vide.' };
        lsSet('privacyPin', await sha256(pin)); return { ok: true };
      },
      async verify(pin) { return { verified: !!lsGet('privacyPin') && (await sha256((pin || '').trim())) === lsGet('privacyPin') }; },
      clearPin() { lsSet('privacyPin', ''); return Promise.resolve({ ok: true }); },
      setStartup(on) { lsSet('privacyStartup', on ? '1' : ''); return Promise.resolve({ ok: true }); }
    },

    // ---- Gmail ----
    gmail: {
      list(opts) { return listFolder(opts.dossier, opts.maxResults); },
      async get(id) {
        const m = await gget(GMAIL + '/messages/' + id + '?format=full');
        if (m.__error) return { error: m.__error };
        const acc = { text: '', html: '', atts: [] }; walkParts(m.payload, acc);
        return { message: {
          id: m.id, threadId: m.threadId || '', messageId: header(m.payload, 'Message-ID'),
          de: header(m.payload, 'From'), a: header(m.payload, 'To'), cc: header(m.payload, 'Cc'),
          sujet: header(m.payload, 'Subject') || '(sans objet)', date: header(m.payload, 'Date'),
          html: acc.html, text: acc.text, attachments: acc.atts
        } };
      },
      async attachment(opts) {
        const o = opts || {};
        const d = await gget(GMAIL + '/messages/' + o.messageId + '/attachments/' + o.attachmentId);
        if (d.__error) return { error: d.__error };
        return { data: d.data || '', size: d.size || 0 };
      },
      // Récupère la pièce jointe et l'ouvre dans un nouvel onglet (aperçu + partage iOS).
      async openAttachment(opts) {
        const o = opts || {};
        const d = await gget(GMAIL + '/messages/' + o.messageId + '/attachments/' + o.attachmentId);
        if (d.__error) return { error: d.__error };
        try {
          const blob = new Blob([b64urlToBytes(d.data || '')], { type: o.mimeType || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank');
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
          return { ok: true };
        } catch (e) { return { error: String(e.message || e) }; }
      },
      async send(mail) {
        if (!mail.to || !mail.to.trim()) return { error: 'Destinataire manquant.' };
        const payload = { raw: buildRaw(mail) }; if (mail.threadId) payload.threadId = mail.threadId;
        const r = mail.draftId
          ? await gsend('POST', GMAIL + '/drafts/send', { id: mail.draftId, message: payload })
          : await gsend('POST', GMAIL + '/messages/send', payload);
        if (r.__error) return { error: r.__error };
        return { ok: true, id: r.id };
      },
      async draft(mail) {
        const message = { raw: buildRaw(mail) }; if (mail.threadId) message.threadId = mail.threadId;
        const r = mail.draftId
          ? await gsend('PUT', GMAIL + '/drafts/' + mail.draftId, { message: message })
          : await gsend('POST', GMAIL + '/drafts', { message: message });
        if (r.__error) return { error: r.__error };
        return { ok: true, id: r.id };
      },
      async trash(opts) {
        if (opts.isDraft) {
          if (!opts.draftId) return { error: 'Brouillon manquant.' };
          const r = await gsend('DELETE', GMAIL + '/drafts/' + opts.draftId, undefined);
          if (r.__error) return { error: r.__error };
          return { ok: true };
        }
        if (!opts.id) return { error: 'Message manquant.' };
        const r = await gsend('POST', GMAIL + '/messages/' + opts.id + '/trash', {});
        if (r.__error) return { error: r.__error };
        return { ok: true };
      },
      async unread() {
        const d = await gget(GMAIL + '/messages?labelIds=INBOX&q=' + encodeURIComponent('is:unread category:primary') + '&maxResults=100');
        if (d.__error) return { error: d.__error };
        return { count: (d.messages || []).length };
      },
      async contacts() {
        const [sent, inbox] = await Promise.all([listFolder('envoyes', 40), listFolder('principal', 40)]);
        const map = new Map();
        const add = (res, field) => ((res && res.messages) || []).forEach((m) => parseAddrList(m[field]).forEach((c) => {
          if (!c.email) return; const ex = map.get(c.email);
          if (ex) { ex.count++; if (!ex.name && c.name) ex.name = c.name; }
          else map.set(c.email, { name: c.name, email: c.email, count: 1 });
        }));
        add(sent, 'a'); add(inbox, 'de');
        return { contacts: Array.from(map.values()).sort((a, b) => b.count - a.count) };
      }
    },

    // ---- Pense-bête (fichier Drive séparé) ----
    notes: {
      load() { return CC.cloud.loadNotes(); },
      save(notes) { return CC.cloud.saveNotes(notes); }
    },

    // ---- Menu natif : inexistant sur le web ----
    onMenu() {}
  };

  // Raccourci Ctrl/Cmd+S → enregistrer (le menu natif n'existe pas sur le web).
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (CC.storage && CC.storage.save) CC.storage.save();
    }
  });

  // Service worker (offline) : uniquement en contexte http(s), jamais en Electron (file://).
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
