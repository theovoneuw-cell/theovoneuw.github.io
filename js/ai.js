'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Onglet "IA" : assistant Gemini conversationnel, avec plusieurs discussions.
// Chaque discussion garde son historique (multi-tour) ; tout est stocké en local
// sur l'appareil (localStorage) — indépendant de la compta. Utilise l'API IA
// déjà en place (window.api.ai.generate) qui accepte désormais un historique.
// ---------------------------------------------------------------------------
const AI_KEY = 'aiChats';
const AI_SYSTEM = "Tu es l'assistant IA de Théo, micro-entrepreneur (prestations son et musique). "
  + "Tu réponds en français, de façon claire et concise. Tu peux aider sur tout : rédaction, "
  + "questions administratives/compta, idées, explications, etc. Si on te demande un mail, "
  + "donne un texte prêt à copier. Un résumé chiffré et à jour de sa comptabilité (CA, URSSAF, "
  + "factures, seuils, trajets) t'est fourni ci-dessous : appuie-toi dessus pour répondre "
  + "précisément (montants en euros). Tous ces chiffres restent confidentiels et locaux. "
  + "Si une donnée manque pour répondre, dis-le simplement.";

CC.ai = {
  _chats: null,
  _currentId: '',
  _busy: false,
  _bound: false,

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
      box.innerHTML = '<div class="ai-welcome">Pose ta question à Gemini.<br><span class="muted">Il connaît ta compta (CA, URSSAF, factures, seuils, trajets) — ex. « combien j\'ai encaissé ce trimestre ? », « quelles factures sont en retard ? », « prépare ma déclaration URSSAF ». Les conversations restent sur cet appareil.</span></div>';
    } else {
      box.innerHTML = chat.messages.map((m) =>
        `<div class="ai-msg ai-${m.role === 'model' ? 'bot' : 'me'}"><div class="ai-bubble">${aEsc(m.text)}</div></div>`
      ).join('') + (this._busy ? '<div class="ai-msg ai-bot"><div class="ai-bubble ai-typing">…</div></div>' : '');
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

  async send() {
    if (this._busy) return;
    const input = document.getElementById('aiInput');
    const text = (input ? input.value : '').trim();
    if (!text) return;
    if (CC._geminiReady === false) { CC.toast("Configure d'abord ta clé Gemini (Paramètres → Connexions & IA).", 'err'); return; }

    let chat = this._current();
    if (!chat) chat = this._create();
    chat.messages.push({ role: 'user', text: text });
    if (chat.messages.filter((m) => m.role === 'user').length === 1) chat.title = text.slice(0, 48);
    chat.updatedAt = Date.now();
    if (input) input.value = '';
    this._renderList(); this._setBusy(true); this._renderMessages(); this.save();

    const ctx = CC.ai._comptaContext();
    const system = AI_SYSTEM + (ctx ? ('\n\n--- Comptabilité actuelle de Théo (confidentiel) ---\n' + ctx) : '');
    let r;
    try {
      r = await window.api.ai.generate({
        model: (CC.state.settings && CC.state.settings.aiModel) || 'gemini-2.0-flash',
        system: system,
        messages: chat.messages.map((m) => ({ role: m.role, text: m.text })),
        temperature: 0.7
      });
    } catch (e) { r = { error: String(e.message || e) }; }

    this._setBusy(false);
    if (r && r.error) { CC.toast('Réponse impossible.', 'err'); chat.messages.push({ role: 'model', text: '⚠️ ' + r.error }); }
    else { chat.messages.push({ role: 'model', text: (r && r.text) || '(réponse vide)' }); }
    chat.updatedAt = Date.now();
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

    this._bound = true;
  }
};

function aEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
