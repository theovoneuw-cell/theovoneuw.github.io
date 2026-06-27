'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Mails — lecture de la messagerie Gmail (boîte principale, envoyés, brouillons).
// Étape 1 : consultation seule. (L'envoi / la composition viendront en étape 2.)
// ---------------------------------------------------------------------------
CC.mailbox = {
  _folder: 'principal',
  _bound: false,
  _list: [],

  bind() {
    if (this._bound) return;
    document.querySelectorAll('.mfolder').forEach((b) => {
      b.addEventListener('click', () => { CC.mailbox._folder = b.dataset.folder; CC.mailbox.render(); });
    });
    const r = document.getElementById('mailRefresh');
    if (r) r.addEventListener('click', () => CC.mailbox.render());

    const list = document.getElementById('mailList');
    if (list) list.addEventListener('click', (e) => {
      if (e.target.closest('#mailConnect')) { CC.switchTab('settings'); return; }
      const del = e.target.closest('.mitem-del');
      if (del) { e.stopPropagation(); const it = del.closest('.mitem'); if (it) CC.mailbox._del(it.dataset.id, it.dataset.draft || ''); return; }
      const it = e.target.closest('.mitem[data-id]');
      if (it) CC.mailbox._open(it.dataset.id, it);
    });

    // Réponse / transfert + liens des mails -> navigateur (jamais dans l'app)
    const reader = document.getElementById('mailReader');
    if (reader) reader.addEventListener('click', (e) => {
      const act = e.target.closest('button[data-mact]');
      if (act) {
        if (act.dataset.mact === 'reply') CC.mailbox._reply();
        else if (act.dataset.mact === 'forward') CC.mailbox._forward();
        else if (act.dataset.mact === 'trash' && CC.mailbox._current) CC.mailbox._del(CC.mailbox._current.id, '');
        return;
      }
      const a = e.target.closest('a[href]');
      if (a) { e.preventDefault(); const h = a.getAttribute('href'); if (h && /^https?:/i.test(h)) window.api.openUrl(h); }
    });

    // Bouton "Nouveau message"
    const compose = document.getElementById('mailCompose');
    if (compose) compose.addEventListener('click', () => CC.mailbox._openCompose({}));

    // Modale de composition (créée une seule fois)
    if (!document.getElementById('mailModal')) {
      const m = document.createElement('div');
      m.id = 'mailModal';
      m.className = 'modal-backdrop hidden';
      m.innerHTML = '<div class="modal modal-lg"><div id="mailModalBody"></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-mrm]');
        if (rm) { CC.mailbox._removeAttachment(parseInt(rm.dataset.mrm, 10)); return; }
        if (e.target.id === 'mailModal' || e.target.closest('[data-mclose]')) { CC.mailbox._closeCompose(); return; }
        if (e.target.closest('#mcSend')) { CC.mailbox._send(); return; }
        if (e.target.closest('#mcDraft')) { CC.mailbox._saveDraft(); return; }
        if (e.target.closest('#mcAI')) { CC.mailbox._aiHelp(); return; }
      });
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') CC.mailbox._closeCompose(); });

    this._bound = true;
  },

  async render() {
    document.querySelectorAll('.mfolder').forEach((b) => b.classList.toggle('active', b.dataset.folder === this._folder));
    const list = document.getElementById('mailList');
    const reader = document.getElementById('mailReader');
    if (!list) return;
    list.innerHTML = '<div class="ck-empty">Chargement des mails…</div>';
    if (reader) reader.innerHTML = '<div class="mail-empty">Sélectionne un message pour le lire.</div>';

    let res;
    try { res = await window.api.gmail.list({ dossier: this._folder, maxResults: 25 }); }
    catch (e) { res = { error: e.message }; }

    if (res && res.error) {
      if (/connect|autoris|non connecté/i.test(res.error)) {
        list.innerHTML = `<div class="mail-empty">${esc(res.error)}<br><button class="btn btn-primary" id="mailConnect" style="margin-top:12px">Configurer / reconnecter Google</button></div>`;
      } else {
        list.innerHTML = `<div class="mail-empty">${esc(res.error)}</div>`;
      }
      return;
    }

    if (CC.updateMailBadge) CC.updateMailBadge();   // rafraîchit le compteur non lus
    this._list = (res && res.messages) || [];
    if (!this._list.length) { list.innerHTML = '<div class="mail-empty">Aucun message.</div>'; return; }

    const sent = (this._folder !== 'principal');
    list.innerHTML = this._list.map((m) => {
      const who = sent ? ('À : ' + persona(m.a)) : persona(m.de);
      const delTitle = this._folder === 'brouillons' ? 'Supprimer le brouillon' : 'Mettre à la corbeille';
      return `<div class="mitem${m.nonLu ? ' unread' : ''}" data-id="${esc(m.id)}" data-draft="${esc(m.draftId || '')}">
        <button class="mitem-del" title="${delTitle}" aria-label="${delTitle}">🗑</button>
        <div class="mitem-top">
          <span class="mitem-who">${esc(who)}</span>
          <span class="mitem-date">${esc(shortDate(m.dateMs))}</span>
        </div>
        <div class="mitem-subj">${esc(m.sujet)}</div>
        <div class="mitem-prev">${esc(m.apercu)}</div>
      </div>`;
    }).join('');
  },

  async _open(id, el) {
    const reader = document.getElementById('mailReader');
    if (!reader) return;
    document.querySelectorAll('.mitem').forEach((x) => x.classList.remove('sel'));
    if (el) { el.classList.add('sel'); el.classList.remove('unread'); }
    reader.innerHTML = '<div class="mail-empty">Ouverture…</div>';

    let res;
    try { res = await window.api.gmail.get(id); }
    catch (e) { res = { error: e.message }; }
    if (res && res.error) { reader.innerHTML = `<div class="mail-empty">${esc(res.error)}</div>`; return; }

    const m = res.message;
    this._current = m;
    let body;
    if (m.html) body = `<div class="mail-body">${sanitize(m.html)}</div>`;
    else body = `<div class="mail-body mail-body-text">${esc(m.text || '(message vide)')}</div>`;

    reader.innerHTML = `
      <div class="mail-msg-head">
        <div class="mail-msg-top">
          <h2>${esc(m.sujet)}</h2>
          <div class="mail-msg-actions">
            <button class="btn" data-mact="reply">↩ Répondre</button>
            <button class="btn" data-mact="forward">➤ Transférer</button>
            ${this._folder !== 'brouillons' ? '<button class="btn btn-danger" data-mact="trash" title="Mettre à la corbeille">🗑 Supprimer</button>' : ''}
          </div>
        </div>
        <div class="mail-msg-meta"><b>${esc(persona(m.de))}</b> <span class="muted">${esc(emailOnly(m.de))}</span></div>
        ${m.a ? `<div class="mail-msg-meta muted">À : ${esc(m.a)}</div>` : ''}
        <div class="mail-msg-meta muted">${esc(longDate(m.date))}</div>
      </div>
      ${body}`;
    reader.scrollTop = 0;
  },

  // ----- Suppression (corbeille) -----
  async _del(id, draftId) {
    if (!id && !draftId) return;
    const isDraft = this._folder === 'brouillons';
    let res;
    try {
      res = await CC.dialog({
        type: 'warning',
        buttons: ['Annuler', isDraft ? 'Supprimer' : 'Mettre à la corbeille'],
        defaultId: 1, cancelId: 0,
        title: isDraft ? 'Supprimer le brouillon' : 'Supprimer ce message',
        message: isDraft ? 'Supprimer définitivement ce brouillon ?' : 'Déplacer ce message vers la corbeille Gmail ?',
        detail: isDraft ? 'Cette action est définitive.' : 'Vous pourrez le récupérer dans la corbeille de Gmail pendant environ 30 jours.'
      });
    } catch (_) { res = { response: 1 }; }
    if (!res || res.response !== 1) return;

    let r;
    try { r = await window.api.gmail.trash({ id, draftId, isDraft }); }
    catch (e) { r = { error: String(e.message || e) }; }
    if (r && r.error) { CC.toast(r.error, 'err'); return; }

    CC.toast(isDraft ? 'Brouillon supprimé.' : 'Message mis à la corbeille.', 'ok');
    // Retire la ligne de la liste sans tout recharger
    this._list = (this._list || []).filter((m) => m.id !== id);
    const el = document.querySelector('.mitem[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (el) el.remove();
    // Vide le lecteur si le message ouvert était celui supprimé
    if (this._current && this._current.id === id) {
      const reader = document.getElementById('mailReader');
      if (reader) reader.innerHTML = '<div class="mail-empty">Sélectionne un message pour le lire.</div>';
      this._current = null;
    }
    if (!this._list.length) {
      const list = document.getElementById('mailList');
      if (list) list.innerHTML = '<div class="mail-empty">Aucun message.</div>';
    }
  },

  // ----- Composition / réponse / transfert -----
  _openCompose(pre) {
    pre = pre || {};
    this._show(`
      <div class="ev-head">
        <h2>${esc(pre.titre || 'Nouveau message')}</h2>
        <button class="ev-x" data-mclose title="Fermer">✕</button>
      </div>
      <div class="ev-form">
        <label class="ev-f">À<span class="mc-cc-toggle"><span class="mc-ac"><input id="mc_to" type="text" autocomplete="off" placeholder="destinataire@exemple.fr" value="${esc(pre.to || '')}"><div class="ac-list hidden" id="mc_toAC"></div></span><button type="button" class="lnk" id="mcCcToggle">Cc / Cci</button></span></label>
        <label class="ev-f hidden" id="mc_ccRow">Cc<span class="mc-ac"><input id="mc_cc" type="text" autocomplete="off" placeholder="copie@exemple.fr (séparer par des virgules)"><div class="ac-list hidden" id="mc_ccAC"></div></span></label>
        <label class="ev-f hidden" id="mc_bccRow">Cci (copie cachée)<span class="mc-ac"><input id="mc_bcc" type="text" autocomplete="off" placeholder="copie-cachée@exemple.fr"><div class="ac-list hidden" id="mc_bccAC"></div></span></label>
        <label class="ev-f">Objet<input id="mc_subject" type="text" placeholder="Objet du message" value="${esc(pre.subject || '')}"></label>
        <label class="ev-f">Message<textarea id="mc_body" rows="9" placeholder="Écris ton message…">${esc(pre.body || '')}</textarea></label>
        <div class="ev-f">Pièces jointes
          <div class="mc-attach">
            <button type="button" class="btn btn-ghost" id="mcAttach"><svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>Joindre un fichier</button>
            <input type="file" id="mc_files" multiple hidden>
            <div id="mc_attachList" class="mc-attach-list"></div>
          </div>
        </div>
      </div>
      <div class="mail-compose-actions">
        <button class="btn btn-coral" id="mcAI" title="Laisser Gemini proposer un texte (il n'envoie jamais)">Aide à la rédaction</button>
        <span class="mail-spin hidden" id="mcSpin">Génération…</span>
        <span class="spacer"></span>
        <button class="btn" data-mclose>Annuler</button>
        <button class="btn" id="mcDraft">Enregistrer le brouillon</button>
        <button class="btn btn-primary" id="mcSend">Envoyer</button>
      </div>
    `);
    // Contexte de fil (réponse) conservé hors DOM
    this._ctx = { threadId: pre.threadId || '', inReplyTo: pre.inReplyTo || '' };
    this._attachments = [];
    this._renderAttachments();

    // Cc / Cci : afficher au clic
    const ccBtn = document.getElementById('mcCcToggle');
    if (ccBtn) ccBtn.addEventListener('click', () => {
      document.getElementById('mc_ccRow').classList.remove('hidden');
      document.getElementById('mc_bccRow').classList.remove('hidden');
      ccBtn.classList.add('hidden');
    });
    // Pièces jointes
    const attachBtn = document.getElementById('mcAttach');
    const fileInput = document.getElementById('mc_files');
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => { CC.mailbox._addFiles(e.target.files); e.target.value = ''; });
    }
    setTimeout(() => { const el = document.getElementById(pre.to ? 'mc_subject' : 'mc_to'); if (el) el.focus(); }, 60);
    CC.mailbox._attachContactAC('mc_to', 'mc_toAC');
    CC.mailbox._attachContactAC('mc_cc', 'mc_ccAC');
    CC.mailbox._attachContactAC('mc_bcc', 'mc_bccAC');
    CC.mailbox._loadContacts();
  },

  // Carnet d'adresses (déduit des mails), récupéré une fois par session.
  async _loadContacts() {
    if (this._contacts) return;
    try { const r = await window.api.gmail.contacts(); this._contacts = (r && r.contacts) || []; }
    catch (_) { this._contacts = []; }
  },

  // Autocomplétion maison (style de l'app) sur un champ destinataire/Cc/Cci.
  // Gère les listes séparées par des virgules : ne complète que le dernier élément.
  _attachContactAC(inputId, listId) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!input || !list) return;

    const hide = () => { list.classList.add('hidden'); list.innerHTML = ''; list._items = null; list._sel = -1; };
    const lastToken = (val) => {
      const i = val.lastIndexOf(',');
      return { prefix: i >= 0 ? val.slice(0, i + 1) + ' ' : '', token: (i >= 0 ? val.slice(i + 1) : val).trim() };
    };
    const render = () => {
      const q = lastToken(input.value).token.toLowerCase();
      if (q.length < 1) { hide(); return; }
      const items = (CC.mailbox._contacts || [])
        .filter((c) => (c.email && c.email.includes(q)) || (c.name && c.name.toLowerCase().includes(q)))
        .slice(0, 8);
      if (!items.length) { hide(); return; }
      list._items = items; list._sel = -1;
      list.innerHTML = items.map((c, i) =>
        `<div class="ac-item" data-i="${i}"><span class="ac-l">${esc(c.name || c.email)}</span>${c.name ? `<span class="ac-c">${esc(c.email)}</span>` : ''}</div>`
      ).join('');
      list.classList.remove('hidden');
    };
    const choose = (c) => {
      const { prefix } = lastToken(input.value);
      input.value = prefix + (c.name ? `${c.name} <${c.email}>` : c.email);
      hide();
      input.focus();
    };

    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('keydown', (e) => {
      if (list.classList.contains('hidden') || !list._items) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); list._sel = Math.min(list._items.length - 1, list._sel + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list._sel = Math.max(0, list._sel - 1); }
      else if (e.key === 'Enter' && list._sel >= 0) { e.preventDefault(); choose(list._items[list._sel]); return; }
      else if (e.key === 'Escape') { hide(); return; }
      else return;
      Array.from(list.children).forEach((el, i) => el.classList.toggle('sel', i === list._sel));
    });
    list.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.ac-item'); if (!it) return;
      e.preventDefault();   // garde le focus, évite le blur prématuré
      choose(list._items[+it.dataset.i]);
    });
    input.addEventListener('blur', () => setTimeout(hide, 150));
  },

  async _addFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) { CC.toast(`"${f.name}" dépasse 20 Mo — ignoré.`, 'err'); continue; }
      try {
        const dataB64 = await fileToB64(f);
        this._attachments.push({ filename: f.name, mimeType: f.type || 'application/octet-stream', dataB64, size: f.size });
      } catch (_) { CC.toast(`Lecture de "${f.name}" impossible.`, 'err'); }
    }
    this._renderAttachments();
  },

  _removeAttachment(i) { this._attachments.splice(i, 1); this._renderAttachments(); },

  _renderAttachments() {
    const box = document.getElementById('mc_attachList');
    if (!box) return;
    const list = this._attachments || [];
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = list.map((a, i) => `<span class="mc-chip"><span class="mc-chip-name">${esc(a.filename)}</span><span class="mc-chip-size">${humanSize(a.size)}</span><button type="button" class="mc-chip-x" data-mrm="${i}" title="Retirer">✕</button></span>`).join('');
  },

  _reply() {
    const m = this._current; if (!m) return;
    const orig = (m.text || stripHtml(m.html) || '').trim();
    const quote = orig ? '\n\n' + ('Le ' + longDate(m.date) + ', ' + persona(m.de) + ' a écrit :\n' + orig.split('\n').map((l) => '> ' + l).join('\n')) : '';
    this._openCompose({
      titre: 'Répondre',
      to: emailOnly(m.de),
      subject: /^re\s*:/i.test(m.sujet) ? m.sujet : 'Re: ' + m.sujet,
      body: quote,
      threadId: m.threadId,
      inReplyTo: m.messageId
    });
  },

  _forward() {
    const m = this._current; if (!m) return;
    const orig = (m.text || stripHtml(m.html) || '').trim();
    const head = `\n\n----- Message transféré -----\nDe : ${m.de}\nDate : ${longDate(m.date)}\nObjet : ${m.sujet}\n${m.a ? 'À : ' + m.a + '\n' : ''}\n${orig}`;
    this._openCompose({
      titre: 'Transférer',
      to: '',
      subject: /^fwd?\s*:/i.test(m.sujet) ? m.sujet : 'Fwd: ' + m.sujet,
      body: head
    });
  },

  _payload() {
    return {
      to: val('mc_to'), cc: val('mc_cc'), bcc: val('mc_bcc'),
      subject: val('mc_subject'), body: val('mc_body'),
      threadId: this._ctx.threadId, inReplyTo: this._ctx.inReplyTo,
      attachments: this._attachments || []
    };
  },

  async _send() {
    if (!val('mc_to').trim()) { CC.toast('Indique au moins un destinataire.', 'err'); return; }
    const btn = document.getElementById('mcSend');
    btn.disabled = true; btn.textContent = 'Envoi…';
    let res;
    try { res = await window.api.gmail.send(this._payload()); }
    catch (e) { res = { error: String(e.message || e) }; }
    btn.disabled = false; btn.textContent = 'Envoyer';
    if (res && res.error) { CC.toast(res.error, 'err'); return; }
    CC.toast('Message envoyé ✓', 'ok');
    this._closeCompose();
    if (this._folder === 'envoyes') this.render();
  },

  async _saveDraft() {
    const btn = document.getElementById('mcDraft');
    btn.disabled = true; btn.textContent = 'Enregistrement…';
    let res;
    try { res = await window.api.gmail.draft(this._payload()); }
    catch (e) { res = { error: String(e.message || e) }; }
    btn.disabled = false; btn.textContent = 'Enregistrer le brouillon';
    if (res && res.error) { CC.toast(res.error, 'err'); return; }
    CC.toast('Brouillon enregistré ✓', 'ok');
    this._closeCompose();
    if (this._folder === 'brouillons') this.render();
  },

  // Aide IA : Gemini propose un texte dans le champ Message. Il n'envoie JAMAIS.
  async _aiHelp() {
    if (CC._geminiReady === false) { CC.toast('Configure d\'abord ta clé Gemini (Paramètres).', 'err'); return; }
    const to = val('mc_to'), subject = val('mc_subject'), body = val('mc_body');
    const spin = document.getElementById('mcSpin'), btn = document.getElementById('mcAI');
    spin.classList.remove('hidden'); btn.disabled = true;
    const sig = (CC.state.settings.mailSignature || '').trim();
    let prompt = 'Rédige un mail professionnel en français.\n';
    if (to) prompt += `Destinataire : ${to}.\n`;
    if (subject) prompt += `Objet : ${subject}.\n`;
    if (body.trim()) prompt += `Points à intégrer / brouillon existant :\n${body}\n`;
    prompt += '\nDonne uniquement le corps du mail (pas la ligne Objet), concis, paragraphes courts. ';
    prompt += sig ? `Termine par cette signature exacte :\n${sig}` : 'Termine par une formule de politesse simple.';
    try {
      const r = await window.api.ai.generate({
        model: CC.state.settings.aiModel || 'gemini-2.0-flash',
        system: 'Tu es l\'assistant d\'un micro-entrepreneur (son et musique). Tu rédiges des mails clairs et polis en français. Tu n\'envoies jamais de mail, tu proposes seulement un texte.',
        prompt, temperature: 0.7
      });
      if (r.error) { CC.toast('Génération impossible.', 'err'); }
      else { document.getElementById('mc_body').value = r.text; }
    } catch (e) { CC.toast('Erreur IA : ' + e.message, 'err'); }
    finally { spin.classList.add('hidden'); btn.disabled = false; }
  },

  _show(html) {
    const back = document.getElementById('mailModal');
    const inner = document.getElementById('mailModalBody');
    if (!back || !inner) return;
    inner.innerHTML = html;
    back.classList.remove('hidden');
  },
  _closeCompose() {
    const back = document.getElementById('mailModal');
    if (back) back.classList.add('hidden');
  }
};

// ----- helpers -----
function persona(addr) {
  if (!addr) return '(inconnu)';
  const m = addr.match(/^\s*"?([^"<]*?)"?\s*<.*>\s*$/);
  const name = m && m[1].trim();
  return name || emailOnly(addr);
}
function emailOnly(addr) {
  if (!addr) return '';
  const m = addr.match(/<([^>]+)>/);
  return m ? m[1] : addr.trim();
}
function shortDate(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function longDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || '';
  return cap(d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
// Nettoie le HTML d'un mail avant affichage (le CSP bloque déjà scripts/images distantes)
function sanitize(html) {
  return String(html)
    .replace(/<\s*(script|style|link|meta|title|head|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|link|meta|title|base)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function humanSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' o';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' Ko';
  return (n / 1024 / 1024).toFixed(1) + ' Mo';
}
async function fileToB64(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
