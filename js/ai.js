'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Onglet "IA" : assistant Gemini conversationnel, avec plusieurs discussions.
// Chaque discussion garde son historique (multi-tour) ; tout est stocké en local
// sur l'appareil (localStorage) — indépendant de la compta. Utilise l'API IA
// déjà en place (window.api.ai.generate) qui accepte désormais un historique.
// ---------------------------------------------------------------------------
const AI_KEY = 'aiChats';
const AI_TZ = 'Europe/Paris';
const AI_SYSTEM = "Tu es l'assistant IA de Théo, micro-entrepreneur (prestations son et musique). "
  + "Tu réponds en français, de façon claire et concise. Tu peux aider sur tout : rédaction, "
  + "questions administratives/compta, idées, explications, etc. Si on te demande un mail, "
  + "donne un texte prêt à copier. Un résumé chiffré et à jour de sa comptabilité (CA, URSSAF, "
  + "factures, seuils, trajets) t'est fourni ci-dessous : appuie-toi dessus pour répondre "
  + "précisément (montants en euros). Tous ces chiffres restent confidentiels et locaux. "
  + "Si une donnée manque pour répondre, dis-le simplement.";

// --- Function calling : outils Google Agenda mis à la disposition de Gemini. ---
const AI_GCAL_TOOLS = [
  {
    name: 'lister_evenements',
    description: "Liste les événements de l'agenda Google de Théo entre deux dates. Sert à répondre aux questions sur le planning et, OBLIGATOIREMENT, à retrouver l'identifiant (id) d'un événement AVANT de le modifier ou le supprimer.",
    parameters: {
      type: 'OBJECT',
      properties: {
        timeMin: { type: 'STRING', description: 'Début de la plage au format RFC3339, ex 2026-07-11T00:00:00+02:00' },
        timeMax: { type: 'STRING', description: 'Fin de la plage au format RFC3339' }
      },
      required: ['timeMin', 'timeMax']
    }
  },
  {
    name: 'creer_evenement',
    description: "Crée un nouvel événement dans l'agenda Google de Théo.",
    parameters: {
      type: 'OBJECT',
      properties: {
        titre: { type: 'STRING', description: "Titre de l'événement" },
        debut: { type: 'STRING', description: "Début. Si journee=true : date 'AAAA-MM-JJ'. Sinon date-heure locale 'AAAA-MM-JJTHH:MM:SS' (heure de Paris)." },
        fin: { type: 'STRING', description: "Fin, même format que debut. Optionnel : par défaut +1h (événement horaire) ou la journée même (journée entière)." },
        journee: { type: 'BOOLEAN', description: 'true pour un événement sur toute la journée (sans heure).' },
        lieu: { type: 'STRING', description: 'Lieu (optionnel)' },
        description: { type: 'STRING', description: 'Notes (optionnel)' },
        recurrence: { type: 'STRING', description: "Récurrence au format RRULE iCalendar, SANS le préfixe 'RRULE:'. Exemples : 'FREQ=WEEKLY;BYDAY=FR' (tous les vendredis), 'FREQ=WEEKLY;BYDAY=MO,WE' (lundi et mercredi), 'FREQ=DAILY;COUNT=10' (10 jours), 'FREQ=MONTHLY;BYMONTHDAY=1', 'FREQ=WEEKLY;INTERVAL=2' (une semaine sur deux). Pour une date de fin, ajoute ';UNTIL=AAAAMMJJ' (ex ';UNTIL=20261231'). Laisse vide pour un événement unique." }
      },
      required: ['titre', 'debut']
    }
  },
  {
    name: 'modifier_evenement',
    description: "Modifie un événement existant. Fournir l'id (obtenu via lister_evenements) et UNIQUEMENT les champs à changer.",
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING', description: "Identifiant de l'événement" },
        titre: { type: 'STRING' },
        debut: { type: 'STRING', description: "Nouveau début (même format que pour creer_evenement)" },
        fin: { type: 'STRING', description: 'Nouvelle fin' },
        journee: { type: 'BOOLEAN' },
        lieu: { type: 'STRING' },
        description: { type: 'STRING' },
        recurrence: { type: 'STRING', description: "Nouvelle règle RRULE (même format que pour creer_evenement, sans 'RRULE:'). Chaîne vide pour retirer la récurrence." }
      },
      required: ['id']
    }
  },
  {
    name: 'supprimer_evenement',
    description: "Supprime définitivement un événement de l'agenda. Fournir l'id (obtenu via lister_evenements).",
    parameters: {
      type: 'OBJECT',
      properties: { id: { type: 'STRING', description: "Identifiant de l'événement" } },
      required: ['id']
    }
  }
];

// Normalise une date-heure locale 'AAAA-MM-JJTHH:MM' en ajoutant les secondes si besoin.
function aiNormDT(s) {
  s = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return s + ':00';
  return s;
}
// Jour suivant d'une date 'AAAA-MM-JJ' (pour end.date, exclusive côté Google).
function aiNextDay(d) {
  const dt = new Date(String(d) + 'T00:00:00');
  dt.setDate(dt.getDate() + 1);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
// +1h sur une date-heure locale naïve 'AAAA-MM-JJTHH:MM:SS'.
function aiPlusHour(s) {
  const dt = new Date(aiNormDT(s));
  if (isNaN(dt.getTime())) return aiNormDT(s);
  dt.setHours(dt.getHours() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) + 'T' + p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds());
}
// Construit le corps d'événement Google Calendar à partir des arguments du modèle.
function aiBuildEvent(a) {
  const b = {};
  if (a.titre != null) b.summary = String(a.titre);
  if (a.lieu != null) b.location = String(a.lieu);
  if (a.description != null) b.description = String(a.description);
  const journee = !!a.journee;
  if (a.debut) {
    if (journee) {
      b.start = { date: String(a.debut) };
      b.end = { date: a.fin ? String(a.fin) : aiNextDay(a.debut) };
    } else {
      b.start = { dateTime: aiNormDT(a.debut), timeZone: AI_TZ };
      b.end = { dateTime: aiNormDT(a.fin || aiPlusHour(a.debut)), timeZone: AI_TZ };
    }
  } else if (a.fin) {
    // Modification de la seule fin.
    b.end = journee ? { date: String(a.fin) } : { dateTime: aiNormDT(a.fin), timeZone: AI_TZ };
  }
  // Récurrence : Google attend un tableau de lignes RRULE. Chaîne vide = on retire
  // la récurrence (tableau vide accepté par l'API en PATCH).
  if (a.recurrence != null) {
    const rule = String(a.recurrence).trim();
    if (!rule) b.recurrence = [];
    else b.recurrence = [/^RRULE:/i.test(rule) ? rule : ('RRULE:' + rule)];
  }
  return b;
}
// Exécute un appel de fonction demandé par Gemini via l'API Agenda (PC ou PWA).
async function aiExecGcalTool(name, args) {
  const g = window.api && window.api.gcal;
  if (!g) return { error: "Agenda indisponible sur cet appareil." };
  args = args || {};
  try {
    if (name === 'lister_evenements') {
      const r = await g.events({ timeMin: args.timeMin, timeMax: args.timeMax, maxResults: 50 });
      if (r && r.error) return { error: r.error };
      return { evenements: (r.events || []).map((e) => ({ id: e.id, titre: e.titre, debut: e.debut, fin: e.fin, lieu: e.lieu, journee: e.journee })) };
    }
    if (name === 'creer_evenement') {
      const r = await g.create(aiBuildEvent(args));
      return (r && r.error) ? { error: r.error } : { ok: true, id: r.id };
    }
    if (name === 'modifier_evenement') {
      if (!args.id) return { error: 'id manquant.' };
      const r = await g.update({ id: args.id, event: aiBuildEvent(args) });
      return (r && r.error) ? { error: r.error } : { ok: true, id: r.id };
    }
    if (name === 'supprimer_evenement') {
      if (!args.id) return { error: 'id manquant.' };
      const r = await g.remove(args.id);
      return (r && r.error) ? { error: r.error } : { ok: true };
    }
  } catch (e) { return { error: String(e && e.message || e) }; }
  return { error: 'Fonction inconnue : ' + name };
}

CC.ai = {
  _chats: null,
  _currentId: '',
  _busy: false,
  _bound: false,
  _pending: [],   // pièces jointes en attente d'envoi : [{name, mimeType, dataB64, size}]

  _load() {
    if (this._chats) return;
    try { this._chats = JSON.parse(localStorage.getItem(AI_KEY) || '[]'); }
    catch (_) { this._chats = []; }
    if (!Array.isArray(this._chats)) this._chats = [];
  },
  save() {
    try { localStorage.setItem(AI_KEY, JSON.stringify(this._chats || [])); } catch (_) {}
  },
  _current() { return (this._chats || []).find((c) => c.id === this._currentId) || null; },

  // Résumé chiffré de la compta, injecté dans le contexte du modèle à chaque envoi
  // pour qu'il réponde précisément (« combien encaissé ce trimestre ? », « factures
  // en retard ? », « prépare ma déclaration URSSAF »…).
  _comptaContext() {
    try {
      const S = CC.state;
      if (!S || !CC.stats) return '';
      const today = new Date();
      const year = (S.selectedYear === 'all' || !S.selectedYear) ? today.getFullYear() : S.selectedYear;
      const fy = CC.stats.forYear(S.factures || [], year);
      const sums = CC.stats.sums(fy, S.settings);
      const cot = CC.stats.cotisationsYear(fy, year, S.settings);
      const eur = (n) => Math.round(n || 0).toLocaleString('fr-FR') + ' €';
      const decl = S.declarations || {};
      const L = [];
      L.push('Date du jour : ' + today.toLocaleDateString('fr-FR') + '.');
      L.push('Année de référence : ' + year + ' (' + fy.length + ' factures).');
      L.push('CA encaissé ' + year + ' : ' + eur(sums.encaisse) + '.');
      L.push('Factures non payées — en attente : ' + eur(sums.attente) + ' ; en retard : ' + eur(sums.retard) + ' ; prévisionnel (pas encore émis) : ' + eur(sums.prevu) + '.');
      cot.trims.forEach((t) => {
        const d = decl[year + '-' + t.trimestre] || {};
        const tags = (d.declare ? ' [déclaré]' : '') + (d.paye ? ' [payé]' : '');
        L.push('T' + t.trimestre + ' ' + year + ' : CA ' + eur(t.encaisse) + ', URSSAF ' + eur(t.urssaf) + ' (taux ' + t.taux + '%)' + tags + '.');
      });
      L.push('URSSAF totale ' + year + ' : ' + eur(cot.urssaf) + ' ; net estimé après URSSAF : ' + eur(cot.net) + '.');
      const base = S.settings.seuilTvaBase, plafond = CC.effPlafond ? CC.effPlafond(year) : 0;
      L.push('Franchise TVA : seuil ' + eur(base) + ', marge restante ' + eur(base - sums.encaisse) + '. Plafond micro ' + year + ' : ' + eur(plafond) + ', marge ' + eur(plafond - sums.encaisse) + '.');
      const top = CC.stats.topClients(fy, 3).map((c) => c.client + ' (' + eur(c.total) + ')');
      if (top.length) L.push('Top clients ' + year + ' : ' + top.join(', ') + '.');
      const traj = (S.trajets || []).filter((t) => String(t.date || '').slice(0, 4) === String(year));
      if (traj.length) L.push('Trajets ' + year + ' : ' + traj.length + ', indemnité km totale ' + eur(traj.reduce((a, t) => a + (+t.indemnite || 0), 0)) + '.');
      return L.join('\n');
    } catch (_) { return ''; }
  },
  _create() {
    const c = { id: (CC.util && CC.util.uid ? CC.util.uid() : String(Date.now())), title: 'Nouvelle discussion', messages: [], updatedAt: Date.now() };
    this._chats.unshift(c);
    this._currentId = c.id;
    return c;
  },

  render() {
    this._load();
    if (!this._currentId) {
      const first = (this._chats || [])[0];
      this._currentId = first ? first.id : '';
    }
    this._renderList();
    this._renderMessages();
  },

  _renderList() {
    const box = document.getElementById('aiList');
    if (!box) return;
    const chats = this._chats || [];
    if (!chats.length) { box.innerHTML = '<div class="ai-empty-list">Aucune discussion.</div>'; return; }
    box.innerHTML = chats.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((c) =>
      `<div class="ai-conv${c.id === this._currentId ? ' active' : ''}" data-aiconv="${aEsc(c.id)}">
        <span class="ai-conv-title">${aEsc(c.title || 'Discussion')}</span>
        <button type="button" class="ai-conv-del" data-aidel="${aEsc(c.id)}" title="Supprimer">✕</button>
      </div>`
    ).join('');
  },

  _renderMessages() {
    const box = document.getElementById('aiMessages');
    if (!box) return;
    const chat = this._current();
    if (!chat || !chat.messages.length) {
      box.innerHTML = '<div class="ai-welcome">Pose ta question à Gemini.<br><span class="muted">Il connaît ta compta (CA, URSSAF, factures, seuils, trajets) — ex. « combien j\'ai encaissé ce trimestre ? », « quelles factures sont en retard ? ». Il peut aussi gérer ton Google Agenda (« ajoute une répétition vendredi 18h », « déplace mon rdv de demain à 15h », « supprime l\'événement de jeudi ») et analyser une image ou un PDF joint (bouton trombone). Les conversations restent sur cet appareil.</span></div>';
    } else {
      box.innerHTML = chat.messages.map((m) => {
        const atts = (m.atts && m.atts.length)
          ? '<div class="ai-msg-atts">' + m.atts.map((a) => `<span class="ai-chip ai-chip-static">${aEsc(a.name)}</span>`).join('') + '</div>'
          : '';
        return `<div class="ai-msg ai-${m.role === 'model' ? 'bot' : 'me'}"><div class="ai-bubble">${atts}${aEsc(m.text)}</div></div>`;
      }).join('') + (this._busy ? '<div class="ai-msg ai-bot"><div class="ai-bubble ai-typing">…</div></div>' : '');
    }
    box.scrollTop = box.scrollHeight;
  },

  _setBusy(b) {
    this._busy = b;
    const btn = document.getElementById('aiSend');
    if (btn) { btn.disabled = b; btn.textContent = b ? 'Gemini réfléchit…' : 'Envoyer'; }
  },

  newChat() {
    this._load();
    // Évite d'empiler des discussions vides : réutilise la 1re si elle est vierge.
    const empty = (this._chats || []).find((c) => !c.messages.length);
    if (empty) this._currentId = empty.id;
    else this._create();
    this._renderList(); this._renderMessages();
    const input = document.getElementById('aiInput'); if (input) input.focus();
  },

  select(id) { this._currentId = id; this._renderList(); this._renderMessages(); },

  remove(id) {
    this._chats = (this._chats || []).filter((c) => c.id !== id);
    if (this._currentId === id) this._currentId = (this._chats[0] && this._chats[0].id) || '';
    this.save(); this._renderList(); this._renderMessages();
  },

  // ---- Pièces jointes (images / PDF / texte) analysées par Gemini ----
  _MAX_ATT: 15 * 1024 * 1024,   // 15 Mo par fichier (limite d'envoi inline Gemini)

  _readFile(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || '');
        const b64 = s.slice(s.indexOf(',') + 1);   // retire "data:...;base64,"
        resolve({ name: file.name || 'fichier', mimeType: file.type || 'application/octet-stream', dataB64: b64, size: file.size || 0 });
      };
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  },

  async addFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const f of files) {
      if (f.size > this._MAX_ATT) { CC.toast('« ' + f.name + ' » dépasse 15 Mo.', 'err'); continue; }
      const a = await this._readFile(f);
      if (a) this._pending.push(a);
    }
    this._renderAttach();
  },

  removeAttach(idx) { this._pending.splice(idx, 1); this._renderAttach(); },

  _renderAttach() {
    const bar = document.getElementById('aiAttachBar');
    if (!bar) return;
    if (!this._pending.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    bar.innerHTML = this._pending.map((a, i) =>
      `<span class="ai-chip" title="${aEsc(a.name)}"><span class="ai-chip-name">${aEsc(a.name)}</span><button type="button" class="ai-chip-del" data-aiatt="${i}" aria-label="Retirer">✕</button></span>`
    ).join('');
  },

  async send() {
    if (this._busy) return;
    const input = document.getElementById('aiInput');
    const text = (input ? input.value : '').trim();
    const atts = this._pending.slice();   // pièces jointes de CE message
    if (!text && !atts.length) return;
    if (CC._geminiReady === false) { CC.toast("Configure d'abord ta clé Gemini (Paramètres → Connexions & IA).", 'err'); return; }

    let chat = this._current();
    if (!chat) chat = this._create();
    // On ne stocke que les métadonnées des pièces jointes (nom/type) dans l'historique
    // local — pas les données base64, qui gonfleraient inutilement le localStorage.
    const userMsg = { role: 'user', text: text };
    if (atts.length) userMsg.atts = atts.map((a) => ({ name: a.name, mimeType: a.mimeType }));
    chat.messages.push(userMsg);
    if (chat.messages.filter((m) => m.role === 'user').length === 1) chat.title = (text || (atts[0] && atts[0].name) || 'Pièce jointe').slice(0, 48);
    chat.updatedAt = Date.now();
    if (input) input.value = '';
    this._pending = []; this._renderAttach();
    this._renderList(); this._setBusy(true); this._renderMessages(); this.save();

    const ctx = CC.ai._comptaContext();
    const now = new Date();
    const agendaOn = !!(window.api && window.api.gcal);
    let system = AI_SYSTEM;
    if (agendaOn) {
      system += "\n\nTu peux aussi GÉRER l'agenda Google de Théo : créer, modifier et supprimer "
        + "des événements (y compris RÉCURRENTS via le paramètre recurrence/RRULE : « tous les vendredis à 18h », "
        + "« un lundi sur deux », « chaque 1er du mois jusqu'en décembre »…), ou consulter son planning, grâce aux fonctions fournies. "
        + "Date et heure actuelles : " + now.toLocaleString('fr-FR') + " (fuseau " + AI_TZ + "). "
        + "Interprète les dates relatives (« demain », « vendredi prochain », « à 15h ») par rapport à cette date. "
        + "Pour MODIFIER ou SUPPRIMER un événement, appelle d'abord lister_evenements sur la bonne plage "
        + "pour récupérer son id, puis agis dessus. Après chaque action réussie, confirme en une phrase ce que tu as fait ; "
        + "en cas d'erreur, explique-la simplement.";
    }
    system += (ctx ? ('\n\n--- Comptabilité actuelle de Théo (confidentiel) ---\n' + ctx) : '');

    // Contenus de départ = historique texte de la discussion. Les données binaires
    // des pièces jointes ne sont pas conservées dans l'historique : on n'envoie que
    // celles du message courant (ci-dessous), les anciennes ont un simple libellé.
    const contents = chat.messages.map((m) => {
      const parts = [];
      if (m.text) parts.push({ text: String(m.text) });
      if (!parts.length && m !== userMsg) parts.push({ text: '(pièce jointe)' });
      return { role: m.role === 'model' ? 'model' : 'user', parts: parts };
    });
    // Pièces jointes du message courant → parts inlineData (analysées par Gemini).
    if (atts.length) {
      const last = contents[contents.length - 1];
      atts.forEach((a) => last.parts.push({ inlineData: { mimeType: a.mimeType, data: a.dataB64 } }));
    }
    const model = (CC.state.settings && CC.state.settings.aiModel) || 'gemini-2.0-flash';
    let r = null;
    // Boucle de function calling : le modèle peut enchaîner plusieurs appels d'outils
    // (lister puis modifier, par ex.) avant de renvoyer sa réponse texte finale.
    for (let step = 0; step < 6; step++) {
      try {
        r = await window.api.ai.generate({
          model: model,
          system: system,
          contents: contents,
          tools: agendaOn ? AI_GCAL_TOOLS : undefined,
          temperature: 0.7
        });
      } catch (e) { r = { error: String(e.message || e) }; }
      if (!r || r.error) break;
      if (r.functionCalls && r.functionCalls.length) {
        contents.push({ role: 'model', parts: r.modelParts });
        const respParts = [];
        for (const fc of r.functionCalls) {
          const result = await aiExecGcalTool(fc.name, fc.args || {});
          respParts.push({ functionResponse: { name: fc.name, response: result } });
        }
        contents.push({ role: 'user', parts: respParts });
        continue;   // on renvoie le résultat au modèle
      }
      break;   // réponse texte finale
    }

    this._setBusy(false);
    if (r && r.error) { CC.toast('Réponse impossible.', 'err'); chat.messages.push({ role: 'model', text: 'Erreur : ' + r.error }); }
    else if (r && r.functionCalls) { chat.messages.push({ role: 'model', text: '(action effectuée)' }); }
    else { chat.messages.push({ role: 'model', text: (r && r.text) || '(réponse vide)' }); }
    chat.updatedAt = Date.now();
    // L'agenda a peut-être changé : rafraîchir l'onglet Agenda s'il est chargé.
    try { const ab = document.getElementById('agendaBody'); if (CC.agenda && CC.agenda.render && ab && ab.childElementCount) CC.agenda.render(); } catch (_) {}
    this._renderMessages(); this._renderList(); this.save();
  },

  bind() {
    if (this._bound) return;
    const newBtn = document.getElementById('aiNew');
    if (!newBtn) return;   // onglet pas dans le DOM
    newBtn.addEventListener('click', () => CC.ai.newChat());

    const sendBtn = document.getElementById('aiSend');
    if (sendBtn) sendBtn.addEventListener('click', () => CC.ai.send());

    const input = document.getElementById('aiInput');
    if (input) input.addEventListener('keydown', (e) => {
      // Entrée = envoyer ; Maj+Entrée = nouvelle ligne.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); CC.ai.send(); }
    });

    const list = document.getElementById('aiList');
    if (list) list.addEventListener('click', (e) => {
      const del = e.target.closest('[data-aidel]');
      if (del) { e.stopPropagation(); CC.ai.remove(del.dataset.aidel); return; }
      const conv = e.target.closest('[data-aiconv]');
      if (conv) CC.ai.select(conv.dataset.aiconv);
    });

    // Pièces jointes : bouton trombone → sélecteur de fichiers ; puce ✕ = retirer.
    const attBtn = document.getElementById('aiAttach');
    const fileIn = document.getElementById('aiFile');
    if (attBtn && fileIn) {
      attBtn.addEventListener('click', () => fileIn.click());
      fileIn.addEventListener('change', () => { CC.ai.addFiles(fileIn.files); fileIn.value = ''; });
    }
    const bar = document.getElementById('aiAttachBar');
    if (bar) bar.addEventListener('click', (e) => {
      const del = e.target.closest('[data-aiatt]');
      if (del) CC.ai.removeAttach(+del.dataset.aiatt);
    });

    this._bound = true;
  }
};

function aEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
