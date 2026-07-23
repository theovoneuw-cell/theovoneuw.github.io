'use strict';
window.CC = window.CC || {};

// Emojis proposés dans le composeur (regroupés par thème, ordre = affichage).
const EMOJI_SET = [
  '🙂','😀','😃','😄','😁','😉','😊','😇','🥰','😍','😘','😗','🙃','😌','😎','🤩',
  '🤗','🤔','🙄','😴','😅','😂','🤣','😢','😭','😉','😳','🥺','😬','😱','🤯','😤',
  '👍','👎','👌','🙏','👏','🙌','💪','🤝','✌️','🤞','👋','✍️','🫡','👀','🧠','💡',
  '❤️','🧡','💛','💚','💙','💜','🖤','💖','💯','🔥','✨','⭐','🎉','🎊','🎁','🏆',
  '✅','☑️','✔️','❌','⚠️','❓','❗','📌','📎','📁','📂','🗂️','📅','📆','⏰','⏳',
  '💶','💰','💳','🧾','📈','📉','📊','🏦','✉️','📧','📨','📬','📞','☎️','📱','💻',
  '🚀','🎯','🤖','☕','🍀','🌟','👉','👈','➡️','⬅️','🔗','🆗','🆕','🔔','🌍','📍',
];

// ---------------------------------------------------------------------------
// Mails — lecture de la messagerie Gmail (boîte principale, envoyés, brouillons).
// Étape 1 : consultation seule. (L'envoi / la composition viendront en étape 2.)
// ---------------------------------------------------------------------------
CC.mailbox = {
  _folder: 'principal',
  _bound: false,
  _list: [],
  _search: '',      // mots-clés de recherche en cours (PC uniquement)
  _reqSeq: 0,       // jeton anti-course : ignore les réponses périmées
  _searchTimer: null,
  // Pagination (comme Gmail) : Gmail ne sait remonter que de page en page, on
  // mémorise donc le jeton de chaque page déjà vue pour pouvoir revenir en arrière.
  _pageSize: 50,
  _page: 0,
  _tokens: [''],    // _tokens[i] = jeton de la page i ('' = première page)
  _total: 0,

  // Repart de la première page (changement de dossier, recherche, actualisation).
  _resetPages() { this._page = 0; this._tokens = ['']; },

  bind() {
    if (this._bound) return;
    document.querySelectorAll('.mfolder').forEach((b) => {
      b.addEventListener('click', () => { CC.mailbox._folder = b.dataset.folder; CC.mailbox._resetPages(); CC.mailbox.render(); });
    });
    const r = document.getElementById('mailRefresh');
    if (r) r.addEventListener('click', () => { CC.mailbox._resetPages(); CC.mailbox.render(); });

    // Pages précédente / suivante (remonter dans les vieux messages)
    const pager = document.getElementById('mailPager');
    if (pager) pager.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pg]');
      if (!b || b.disabled) return;
      const mb = CC.mailbox;
      if (b.dataset.pg === 'next') mb._page++;
      else if (mb._page > 0) mb._page--;
      mb.render();
    });

    // Barre de recherche — disponible partout (PC et téléphone).
    const searchWrap = document.getElementById('mailSearchWrap');
    if (searchWrap) {
      const input = document.getElementById('mailSearch');
      const clear = document.getElementById('mailSearchClear');
      const run = () => {
        const v = input.value.trim();
        if (v === CC.mailbox._search) return;
        CC.mailbox._search = v;
        if (clear) clear.classList.toggle('hidden', !v);
        CC.mailbox._resetPages();
        CC.mailbox.render();
      };
      if (input) {
        // Recherche « live » temporisée (évite un appel réseau par frappe).
        input.addEventListener('input', () => {
          clearTimeout(CC.mailbox._searchTimer);
          CC.mailbox._searchTimer = setTimeout(run, 450);
        });
        // Entrée = recherche immédiate ; Échap = efface.
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); clearTimeout(CC.mailbox._searchTimer); run(); }
          else if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; clearTimeout(CC.mailbox._searchTimer); run(); }
        });
      }
      if (clear) clear.addEventListener('click', () => {
        input.value = ''; clearTimeout(CC.mailbox._searchTimer); run(); input.focus();
      });
    }

    const list = document.getElementById('mailList');
    if (list) list.addEventListener('click', (e) => {
      const mc = e.target.closest('#mailConnect');
      if (mc) {
        // Session Google expirée (déjà connecté) -> reconnexion en un tap ;
        // sinon (pas configuré) -> Paramètres pour saisir l'identifiant.
        if (CC.gauth && CC.gauth.isConnected && CC.gauth.isConnected()) CC.reconnectGoogle(mc);
        else CC.switchTab('settings');
        return;
      }
      const del = e.target.closest('.mitem-del');
      if (del) { e.stopPropagation(); const it = del.closest('.mitem'); if (it) CC.mailbox._del(it.dataset.id, it.dataset.draft || ''); return; }
      const star = e.target.closest('.mitem-star');
      if (star) { e.stopPropagation(); const it = star.closest('.mitem'); if (it) CC.mailbox._applyStar(it.dataset.id, !star.classList.contains('on')); return; }
      const it = e.target.closest('.mitem[data-id]');
      if (it) {
        if (CC.mailbox._folder === 'brouillons') CC.mailbox._editDraft(it.dataset.id, it.dataset.draft || '');
        else CC.mailbox._open(it.dataset.id, it);
      }
    });

    // Réponse / transfert + liens des mails -> navigateur (jamais dans l'app)
    const reader = document.getElementById('mailReader');
    if (reader) reader.addEventListener('click', (e) => CC.mailbox._readerClick(e));

    // Modale de lecture (téléphone) : sur mobile, cliquer un mail l'ouvre en plein
    // écran plutôt que dans un lecteur latéral qu'on ne voit pas. Créée une fois ;
    // partage la même délégation d'événements que le lecteur (favoris, corbeille,
    // répondre, transférer, pièces jointes, liens).
    if (!document.getElementById('mailReadModal')) {
      const rm = document.createElement('div');
      rm.id = 'mailReadModal';
      rm.className = 'modal-backdrop hidden';
      rm.innerHTML = '<div class="modal modal-lg mail-read-modal"><button class="mail-read-x" data-mrclose title="Fermer" aria-label="Fermer">✕</button><div id="mailReadBody" class="mail-reader mail-reader-modal"></div></div>';
      document.body.appendChild(rm);
      rm.addEventListener('click', (e) => {
        if (e.target.id === 'mailReadModal' || e.target.closest('[data-mrclose]')) { CC.mailbox._closeRead(); return; }
        CC.mailbox._readerClick(e);
      });
    }

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
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { CC.mailbox._closeCompose(); CC.mailbox._closeRead(); } });

    this._bound = true;
  },

  async render() {
    document.querySelectorAll('.mfolder').forEach((b) => b.classList.toggle('active', b.dataset.folder === this._folder));
    const list = document.getElementById('mailList');
    const reader = document.getElementById('mailReader');
    if (!list) return;
    const search = this._search || '';
    const seq = ++this._reqSeq;   // marque cette requête ; les réponses plus anciennes seront ignorées
    list.innerHTML = `<div class="ck-empty">${search ? 'Recherche…' : 'Chargement des mails…'}</div>`;
    if (reader) reader.innerHTML = '<div class="mail-empty">Sélectionne un message pour le lire.</div>';
    this._setPager('…');

    let res;
    try {
      res = await window.api.gmail.list({
        dossier: this._folder, maxResults: this._pageSize, recherche: search,
        pageToken: this._tokens[this._page] || ''
      });
    } catch (e) { res = { error: e.message }; }

    if (seq !== this._reqSeq) return;   // une recherche plus récente a été lancée entre-temps

    if (res && res.error) {
      this._setPager('');
      if (/connect|autoris|non connecté/i.test(res.error)) {
        list.innerHTML = `<div class="mail-empty">${esc(res.error)}<br><button class="btn btn-primary" id="mailConnect" style="margin-top:12px">Configurer / reconnecter Google</button></div>`;
      } else {
        list.innerHTML = `<div class="mail-empty">${esc(res.error)}</div>`;
      }
      return;
    }

    if (CC.updateMailBadge) CC.updateMailBadge();   // rafraîchit le compteur non lus
    this._list = (res && res.messages) || [];
    // Mémorise le jeton de la page suivante pour pouvoir avancer, puis revenir.
    this._total = res.total || 0;
    this._tokens.length = this._page + 1;
    if (res.nextPageToken) this._tokens.push(res.nextPageToken);
    this._renderPager();

    if (!this._list.length) {
      list.innerHTML = this._page > 0
        ? '<div class="mail-empty">Fin de la liste — reviens à la page précédente.</div>'
        : (search
          ? `<div class="mail-empty">Aucun mail ne correspond à «&nbsp;${esc(search)}&nbsp;».</div>`
          : '<div class="mail-empty">Aucun message.</div>');
      return;
    }

    // « À : … » pour Envoyés/Brouillons ; expéditeur pour Boîte principale et Favoris.
    const sent = (this._folder === 'envoyes' || this._folder === 'brouillons');
    const isDraftFolder = this._folder === 'brouillons';
    list.innerHTML = this._list.map((m) => {
      const addr = sent ? (m.a || '') : (m.de || '');
      const nom = persona(addr);
      const who = sent ? ('À : ' + nom) : nom;
      const delTitle = isDraftFolder ? 'Supprimer le brouillon' : 'Mettre à la corbeille';
      // Étoile « Favori » (comme Gmail) — pas sur les brouillons.
      const starBtn = isDraftFolder ? ''
        : `<button class="mitem-star${m.favori ? ' on' : ''}" title="${m.favori ? 'Retirer des favoris' : 'Ajouter aux favoris'}" aria-label="Favori">${m.favori ? '★' : '☆'}</button>`;
      return `<div class="mitem${m.nonLu ? ' unread' : ''}" data-id="${esc(m.id)}" data-draft="${esc(m.draftId || '')}">
        <span class="mitem-av" style="background:${avatarColor(addr)}" aria-hidden="true">${esc(initials(nom))}</span>
        <div class="mitem-top">
          <span class="mitem-who">${esc(who)}</span>
          <span class="mitem-date">${esc(shortDate(m.dateMs))}</span>
        </div>
        <div class="mitem-subj">${esc(m.sujet)}${m.pj ? `<span class="mitem-pj" title="Pièce jointe">${ICO.clip}</span>` : ''}</div>
        <div class="mitem-prev">${esc(m.apercu)}</div>
        <div class="mitem-acts">
          ${starBtn}
          <button class="mitem-del" title="${delTitle}" aria-label="${delTitle}">${ICO.trash}</button>
        </div>
      </div>`;
    }).join('');
    list.scrollTop = 0;   // nouvelle page = on repart du haut
  },

  // Message court dans la zone de pagination (chargement, erreur…).
  _setPager(txt) {
    const p = document.getElementById('mailPager');
    if (p) p.innerHTML = txt ? `<span class="gm-range">${esc(txt)}</span>` : '';
  },

  // « 51–100 sur 1 248 · page 2/25 » + flèches, comme Gmail.
  _renderPager() {
    const p = document.getElementById('mailPager');
    if (!p) return;
    const n = this._list.length;
    if (!n) {
      // Page vide : seule la flèche « précédent » a du sens.
      p.innerHTML = this._page === 0 ? '' :
        `<span class="gm-range">fin de la liste</span>
         <button class="gm-pg" data-pg="prev" title="Page précédente" aria-label="Page précédente">‹</button>
         <button class="gm-pg" data-pg="next" aria-label="Page suivante" disabled>›</button>`;
      return;
    }
    const from = this._page * this._pageSize + 1;
    const to = this._page * this._pageSize + n;
    const total = Math.max(this._total, to);
    const pages = Math.max(1, Math.ceil(total / this._pageSize));
    const hasNext = !!this._tokens[this._page + 1];
    const nb = (x) => x.toLocaleString('fr-FR');
    p.innerHTML = `
      <span class="gm-range">${nb(from)}–${nb(to)} sur ${this._search ? 'environ ' : ''}${nb(total)}</span>
      <span class="gm-pages">page ${nb(this._page + 1)} / ${nb(pages)}</span>
      <button class="gm-pg" data-pg="prev" title="Page précédente (messages plus récents)" aria-label="Page précédente"${this._page === 0 ? ' disabled' : ''}>‹</button>
      <button class="gm-pg" data-pg="next" title="Page suivante (messages plus anciens)" aria-label="Page suivante"${hasNext ? '' : ' disabled'}>›</button>`;
  },

  async _open(id, el) {
    // Sur téléphone, le mail s'ouvre dans une modale plein écran (le lecteur
    // latéral n'est pas visible sans faire défiler). Sur PC, lecteur classique.
    const mobile = !!(window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
    const reader = mobile ? this._openRead() : document.getElementById('mailReader');
    if (!reader) return;
    document.querySelectorAll('.mitem').forEach((x) => x.classList.remove('sel'));
    if (el) { el.classList.add('sel'); el.classList.remove('unread'); }
    reader.innerHTML = '<div class="mail-empty">Ouverture…</div>';

    // Marque le message comme lu côté Gmail (retire UNREAD) puis met à jour le
    // compteur de l'onglet. Best-effort : n'empêche pas la lecture si ça échoue.
    const item = (this._list || []).find((m) => m.id === id);
    if (item && item.nonLu) {
      item.nonLu = false;
      if (window.api.gmail.markRead) {
        window.api.gmail.markRead(id)
          .then(() => { if (CC.updateMailBadge) CC.updateMailBadge(); })
          .catch(() => {});
      }
    }

    let res;
    try { res = await window.api.gmail.get(id); }
    catch (e) { res = { error: e.message }; }
    if (res && res.error) { reader.innerHTML = `<div class="mail-empty">${esc(res.error)}</div>`; return; }

    const m = res.message;
    // Reporte l'état « Favori » depuis la ligne de liste (Gmail ne le renvoie pas ici).
    m.favori = item ? !!item.favori : false;
    this._current = m;
    const atts = m.attachments || [];

    // Images inline (signatures) : remplace les src="cid:..." par des data-URI.
    let html = m.html || '';
    if (html) {
      const inlines = atts.filter((a) => a.inline && a.contentId && a.attachmentId);
      for (const a of inlines) {
        try {
          const r = await window.api.gmail.attachment({ messageId: m.id, attachmentId: a.attachmentId });
          if (r && r.data) {
            const uri = 'data:' + (a.mimeType || 'image/png') + ';base64,' + b64urlToStd(r.data);
            html = html.replace(new RegExp('src\\s*=\\s*("|\')cid:' + escapeRe(a.contentId) + '\\1', 'gi'), 'src="' + uri + '"');
          }
        } catch (_) {}
      }
    }
    let body;
    if (html) body = `<div class="mail-body">${sanitize(html)}</div>`;
    else body = `<div class="mail-body mail-body-text">${esc(m.text || '(message vide)')}</div>`;

    // Barre des pièces jointes (téléchargeables), hors images inline.
    const files = atts.filter((a) => !a.inline && a.attachmentId);
    const attBar = files.length ? `<div class="mail-attach-bar">${files.map((a) =>
      `<button type="button" class="mc-chip mail-att" data-matt="${esc(a.attachmentId)}" data-mname="${esc(a.filename)}" data-mmime="${esc(a.mimeType)}" title="Ouvrir « ${esc(a.filename)} »"><span class="mc-chip-name">📎 ${esc(a.filename)}</span>${a.size ? `<span class="mc-chip-size">${humanSize(a.size)}</span>` : ''}</button>`
    ).join('')}</div>` : '';

    const nom = persona(m.de);
    reader.innerHTML = `
      <div class="mail-msg-head">
        <div class="mail-msg-top">
          <h2>${esc(m.sujet)}</h2>
          <div class="mail-msg-actions">
            <button class="mail-ico mail-star-btn${m.favori ? ' on' : ''}" data-mact="star" title="${m.favori ? 'Retirer des favoris' : 'Ajouter aux favoris'}" aria-label="Favori">${m.favori ? '★' : '☆'}</button>
            <button class="mail-ico" data-mact="reply" title="Répondre" aria-label="Répondre">${ICO.reply}</button>
            <button class="mail-ico" data-mact="forward" title="Transférer" aria-label="Transférer">${ICO.forward}</button>
            ${this._folder !== 'brouillons' ? `<button class="mail-ico danger" data-mact="trash" title="Mettre à la corbeille" aria-label="Supprimer">${ICO.trash}</button>` : ''}
          </div>
        </div>
        <div class="mail-from">
          <span class="mail-from-av" style="background:${avatarColor(m.de)}" aria-hidden="true">${esc(initials(nom))}</span>
          <div class="mail-from-txt">
            <div><span class="mail-from-name">${esc(nom)}</span> <span class="mail-from-mail">&lt;${esc(emailOnly(m.de))}&gt;</span></div>
            ${m.a ? `<div class="mail-from-to">À : ${esc(m.a)}${m.cc ? ' · Cc : ' + esc(m.cc) : ''}</div>` : ''}
          </div>
          <span class="mail-from-date">${esc(longDate(m.date))}</span>
        </div>
      </div>
      ${body}
      ${attBar}
      <div class="mail-foot-actions">
        <button class="btn" data-mact="reply">${ICO.reply} Répondre</button>
        <button class="btn" data-mact="forward">${ICO.forward} Transférer</button>
      </div>`;
    reader.scrollTop = 0;
  },

  // Ouvre une pièce jointe : PC -> app par défaut ; iPhone -> nouvel onglet/aperçu.
  async _downloadAttachment(attachmentId, filename, mimeType) {
    const m = this._current; if (!m || !attachmentId) return;
    CC.toast('Ouverture de la pièce jointe…');
    let r;
    try { r = await window.api.gmail.openAttachment({ messageId: m.id, attachmentId, filename, mimeType }); }
    catch (e) { r = { error: String(e.message || e) }; }
    if (r && r.error) CC.toast(r.error, 'err');
  },

  // Ré-édite un brouillon : recharge destinataires/objet/texte + pièces jointes
  // dans le compositeur, et lie le draftId pour mettre à jour le MÊME brouillon.
  async _editDraft(id, draftId) {
    CC.toast('Ouverture du brouillon…');
    let res;
    try { res = await window.api.gmail.get(id); }
    catch (e) { res = { error: String(e.message || e) }; }
    if (res && res.error) { CC.toast(res.error, 'err'); return; }
    const m = res.message;
    // Pièces jointes existantes -> format du compositeur (base64 standard).
    const loaded = [];
    for (const a of (m.attachments || []).filter((x) => x.attachmentId && !x.inline)) {
      try {
        const r = await window.api.gmail.attachment({ messageId: id, attachmentId: a.attachmentId });
        if (r && r.data) loaded.push({ filename: a.filename, mimeType: a.mimeType, dataB64: b64urlToStd(r.data), size: a.size });
      } catch (_) {}
    }
    this._openCompose({
      titre: 'Modifier le brouillon',
      to: m.a || '',
      subject: m.sujet === '(sans objet)' ? '' : m.sujet,
      body: m.text || stripHtml(m.html) || '',
      draftId: draftId
    });
    this._attachments = loaded;
    this._renderAttachments();
    if (m.cc) {
      const cc = document.getElementById('mc_cc'); if (cc) cc.value = m.cc;
      const ccRow = document.getElementById('mc_ccRow'), bccRow = document.getElementById('mc_bccRow'), tog = document.getElementById('mcCcToggle');
      if (ccRow) ccRow.classList.remove('hidden');
      if (bccRow) bccRow.classList.remove('hidden');
      if (tog) tog.classList.add('hidden');
    }
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
    // Vide le lecteur si le message ouvert était celui supprimé (et ferme la
    // modale de lecture sur mobile).
    if (this._current && this._current.id === id) {
      const reader = document.getElementById('mailReader');
      if (reader) reader.innerHTML = '<div class="mail-empty">Sélectionne un message pour le lire.</div>';
      this._closeRead();
      this._current = null;
    }
    if (!this._list.length) {
      const list = document.getElementById('mailList');
      if (list) list.innerHTML = '<div class="mail-empty">Aucun message.</div>';
    }
  },

  // ----- Favoris (étoile Gmail = label STARRED) -----
  // Met à jour l'affichage de l'étoile (ligne de liste + lecteur) pour un message.
  _syncStarUI(id, on) {
    const item = (this._list || []).find((m) => m.id === id);
    if (item) item.favori = on;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
    const lb = document.querySelector('.mitem[data-id="' + sel + '"] .mitem-star');
    if (lb) {
      lb.classList.toggle('on', on);
      lb.textContent = on ? '★' : '☆';
      lb.title = on ? 'Retirer des favoris' : 'Ajouter aux favoris';
    }
    if (this._current && this._current.id === id) {
      this._current.favori = on;
      // Étoile du lecteur latéral (PC) ET de la modale de lecture (téléphone).
      document.querySelectorAll('#mailReader [data-mact="star"], #mailReadBody [data-mact="star"]').forEach((rb) => {
        rb.classList.toggle('on', on);
        rb.innerHTML = on ? '★' : '☆';
        rb.title = on ? 'Retirer des favoris' : 'Ajouter aux favoris';
      });
    }
  },

  // Ajoute / retire l'étoile côté Gmail (mise à jour optimiste, annulée si erreur).
  async _applyStar(id, willStar) {
    if (!id) return;
    this._syncStarUI(id, willStar);
    let r;
    try { r = await window.api.gmail.star({ id, star: willStar }); }
    catch (e) { r = { error: String(e.message || e) }; }
    if (r && r.error) { this._syncStarUI(id, !willStar); CC.toast(r.error, 'err'); return; }
    // Dans le dossier Favoris, retirer l'étoile enlève la ligne de la liste.
    if (this._folder === 'favoris' && !willStar) {
      this._list = (this._list || []).filter((m) => m.id !== id);
      const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
      const el = document.querySelector('.mitem[data-id="' + sel + '"]');
      if (el) el.remove();
      if (!this._list.length) {
        const list = document.getElementById('mailList');
        if (list) list.innerHTML = '<div class="mail-empty">Aucun favori. Clique sur l\'étoile d\'un message pour l\'ajouter ici.</div>';
      }
    }
  },

  // ----- Composition / réponse / transfert -----
  _openCompose(pre) {
    pre = pre || {};
    // Fenêtre de composition façon Gmail : bandeau de titre, champs en lignes
    // (libellé à gauche, filet de séparation), barre d'outils en bas.
    this._show(`
      <div class="mc-head">
        <span class="mc-title">${esc(pre.titre || 'Nouveau message')}</span>
        <button class="mc-x" data-mclose title="Fermer" aria-label="Fermer">✕</button>
      </div>
      <div class="mc-form">
        <label class="ev-f"><span class="mc-lbl">À</span><span class="mc-cc-toggle"><span class="mc-ac"><input id="mc_to" type="text" autocomplete="off" placeholder="destinataire@exemple.fr" value="${esc(pre.to || '')}"><div class="ac-list hidden" id="mc_toAC"></div></span><button type="button" class="lnk" id="mcCcToggle">Cc / Cci</button></span></label>
        <label class="ev-f hidden" id="mc_ccRow"><span class="mc-lbl">Cc</span><span class="mc-ac"><input id="mc_cc" type="text" autocomplete="off" placeholder="copie@exemple.fr (séparer par des virgules)"><div class="ac-list hidden" id="mc_ccAC"></div></span></label>
        <label class="ev-f hidden" id="mc_bccRow"><span class="mc-lbl">Cci</span><span class="mc-ac"><input id="mc_bcc" type="text" autocomplete="off" placeholder="copie cachée@exemple.fr"><div class="ac-list hidden" id="mc_bccAC"></div></span></label>
        <label class="ev-f"><span class="mc-lbl">Objet</span><input id="mc_subject" type="text" placeholder="Objet du message" lang="fr" spellcheck="true" value="${esc(pre.subject || '')}"></label>
        <div class="mc-body-wrap"><textarea id="mc_body" rows="12" lang="fr" spellcheck="true" placeholder="Écris ton message…">${esc(pre.body || '')}</textarea><button type="button" class="mc-emoji-btn" id="mcEmoji" title="Insérer un emoji" aria-label="Insérer un emoji">🙂</button><div class="mc-emoji-pop hidden" id="mcEmojiPop"></div></div>
        <input type="file" id="mc_files" multiple hidden>
        <div id="mc_attachList" class="mc-attach-list"></div>
      </div>
      <div class="mail-compose-actions">
        <button class="btn btn-primary mc-send" id="mcSend">Envoyer</button>
        <button type="button" class="mc-tool" id="mcAttach" title="Joindre un fichier" aria-label="Joindre un fichier"><svg class="ic" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
        <button class="mc-tool mc-tool-ai" id="mcAI" title="Laisser Gemini proposer un texte (il n'envoie jamais)"><svg class="ic" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/><path d="M18 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z"/></svg>Aide à la rédaction</button>
        <span class="mail-spin hidden" id="mcSpin">Génération…</span>
        <span class="spacer"></span>
        <button class="btn" id="mcDraft">Enregistrer le brouillon</button>
        <button class="mc-tool danger" data-mclose title="Fermer sans envoyer" aria-label="Fermer sans envoyer">${ICO.trash}</button>
      </div>
    `);
    // Contexte de fil (réponse) / brouillon édité, conservé hors DOM
    this._ctx = { threadId: pre.threadId || '', inReplyTo: pre.inReplyTo || '', draftId: pre.draftId || '' };
    this._acRenders = [];   // les champs du composeur précédent n'existent plus
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
    // Sélecteur d'emojis (PC et téléphone)
    CC.mailbox._bindEmoji();
    setTimeout(() => { const el = document.getElementById(pre.to ? 'mc_subject' : 'mc_to'); if (el) el.focus(); }, 60);
    CC.mailbox._attachContactAC('mc_to', 'mc_toAC');
    CC.mailbox._attachContactAC('mc_cc', 'mc_ccAC');
    CC.mailbox._attachContactAC('mc_bcc', 'mc_bccAC');
    CC.mailbox._loadContacts();
  },

  // Sélecteur d'emojis du composeur (PC). Insère l'emoji à la position du curseur.
  _bindEmoji() {
    const btn = document.getElementById('mcEmoji');
    const pop = document.getElementById('mcEmojiPop');
    const ta = document.getElementById('mc_body');
    if (!btn || !pop || !ta) return;

    if (!pop._filled) {
      pop.innerHTML = EMOJI_SET.map((e) => `<button type="button" class="mc-emoji" tabindex="-1">${e}</button>`).join('');
      pop._filled = true;
    }
    const close = () => pop.classList.add('hidden');
    const toggle = (ev) => { ev.stopPropagation(); pop.classList.toggle('hidden'); };

    btn.addEventListener('click', toggle);
    pop.addEventListener('mousedown', (ev) => {
      const b = ev.target.closest('.mc-emoji'); if (!b) return;
      ev.preventDefault();   // garde le curseur dans le textarea
      const s = ta.selectionStart, e = ta.selectionEnd, emo = b.textContent;
      ta.value = ta.value.slice(0, s) + emo + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + emo.length;
      ta.focus();
    });
    // Fermeture au clic ailleurs / Échap
    document.addEventListener('mousedown', (ev) => { if (!pop.contains(ev.target) && ev.target !== btn) close(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
  },

  // Carnet d'adresses (déduit des mails), récupéré une fois par session.
  async _loadContacts() {
    if (this._contacts) { this._refreshAC(); return; }
    try { const r = await window.api.gmail.contacts(); this._contacts = (r && r.contacts) || []; }
    catch (_) { this._contacts = []; }
    // Le carnet arrive après l'ouverture du composeur (appel réseau) : on relance
    // l'affichage des suggestions au cas où l'utilisateur a déjà commencé à taper.
    this._refreshAC();
  },

  // Relance chaque autocomplétion active (après chargement des contacts).
  _refreshAC() { (this._acRenders || []).forEach((fn) => { try { fn(); } catch (_) {} }); },

  // Autocomplétion maison (style de l'app) sur un champ destinataire/Cc/Cci.
  // Gère les listes séparées par des virgules : ne complète que le dernier élément.
  _attachContactAC(inputId, listId) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!input || !list) return;
    if (!this._acRenders) this._acRenders = [];

    const hide = () => { list.classList.add('hidden'); list.innerHTML = ''; list._items = null; list._sel = -1; };
    const lastToken = (val) => {
      const i = val.lastIndexOf(',');
      return { prefix: i >= 0 ? val.slice(0, i + 1) + ' ' : '', token: (i >= 0 ? val.slice(i + 1) : val).trim() };
    };
    const render = () => {
      // Ne suggère que si le champ a le focus (évite un rafraîchissement fantôme
      // quand le carnet d'adresses finit de charger sur un autre champ).
      if (document.activeElement !== input) return;
      const q = lastToken(input.value).token.toLowerCase();
      if (q.length < 1) { hide(); return; }
      // Correspondance sur le début d'un mot du nom (nom de famille OU prénom),
      // ou n'importe où dans l'adresse e-mail. Les contacts sont déjà classés par
      // fréquence d'échange ("à qui j'ai déjà écrit" en premier).
      const items = (CC.mailbox._contacts || [])
        .filter((c) => (c.email && c.email.includes(q)) || (c.name && nameMatches(c.name, q)))
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
    // Mémorise ce champ pour pouvoir rafraîchir ses suggestions quand le carnet
    // d'adresses termine de charger (appel réseau asynchrone).
    this._acRenders.push(render);
    input.addEventListener('keydown', (e) => {
      if (list.classList.contains('hidden') || !list._items) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); list._sel = Math.min(list._items.length - 1, list._sel + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list._sel = Math.max(0, list._sel - 1); }
      else if (e.key === 'Enter' && list._sel >= 0) { e.preventDefault(); choose(list._items[list._sel]); return; }
      else if (e.key === 'Escape') { hide(); return; }
      else return;
      Array.from(list.children).forEach((el, i) => el.classList.toggle('sel', i === list._sel));
    });
    // `pointerdown` couvre souris ET tactile (l'ancien `mousedown` ne se
    // déclenchait pas de façon fiable au doigt sur iPhone → suggestions inutiles).
    list.addEventListener('pointerdown', (e) => {
      const it = e.target.closest('.ac-item'); if (!it) return;
      e.preventDefault();   // garde le focus, évite le blur prématuré
      choose(list._items[+it.dataset.i]);
    });
    input.addEventListener('blur', () => setTimeout(hide, 200));
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
    this._closeRead();   // sur mobile, on remplace la lecture par le composeur
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
    this._closeRead();
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
      threadId: this._ctx.threadId, inReplyTo: this._ctx.inReplyTo, draftId: this._ctx.draftId,
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
    // Rafraîchit la liste si on était dans Envoyés, ou si on vient d'envoyer un brouillon.
    if (this._folder === 'envoyes' || this._folder === 'brouillons') this.render();
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

  // Délégation partagée par le lecteur latéral (PC) et la modale (téléphone).
  _readerClick(e) {
    const att = e.target.closest('[data-matt]');
    if (att) { this._downloadAttachment(att.dataset.matt, att.dataset.mname || '', att.dataset.mmime || ''); return; }
    const act = e.target.closest('button[data-mact]');
    if (act) {
      if (act.dataset.mact === 'reply') this._reply();
      else if (act.dataset.mact === 'forward') this._forward();
      else if (act.dataset.mact === 'trash' && this._current) this._del(this._current.id, '');
      else if (act.dataset.mact === 'star' && this._current) this._applyStar(this._current.id, !act.classList.contains('on'));
      return;
    }
    const a = e.target.closest('a[href]');
    if (a) { e.preventDefault(); const h = a.getAttribute('href'); if (h && /^https?:/i.test(h)) window.api.openUrl(h); }
  },

  // Ouvre (affiche) la modale de lecture et renvoie son conteneur de contenu.
  _openRead() {
    const back = document.getElementById('mailReadModal');
    const body = document.getElementById('mailReadBody');
    if (back) { back.classList.remove('hidden'); back.scrollTop = 0; }
    return body;
  },
  _closeRead() {
    const back = document.getElementById('mailReadModal');
    if (back) back.classList.add('hidden');
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
// Petites icônes en trait (même famille que le reste de l'app, pas d'emoji).
const ICO = {
  clip: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  reply: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>',
  forward: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>',
};

// Vrai si l'un des mots du nom commence par la saisie (prénom OU nom de famille),
// insensible à la casse et aux accents. « dup » trouve « Jean Dupont ».
function nameMatches(name, q) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const nq = norm(q);
  if (!nq) return false;
  const nn = norm(name);
  if (nn.startsWith(nq)) return true;
  return nn.split(/[\s,.'-]+/).some((w) => w.startsWith(nq));
}

// Pastille d'initiale : 1 à 2 lettres tirées du nom (ou de l'adresse).
function initials(nom) {
  const s = String(nom || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
  if (!s) return '?';
  const mots = s.split(/\s+/).filter(Boolean);
  if (mots.length >= 2) return (mots[0][0] + mots[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
// Couleur d'avatar déterministe (toujours la même pour un expéditeur donné).
//
// L'ancienne palette listait du cyan, du vert lime et du bleu franc : distinctifs,
// mais étrangers à la charte — la colonne des mails virait à l'arc-en-ciel. On tire
// désormais la teinte sur l'ARC qui relie les deux couleurs de marque, indigo (244°)
// et corail (350°), en passant par le violet. Saturation et luminosité sont fixes :
// les avatars restent distinguables entre eux tout en formant une seule famille,
// et le blanc dessus garde le même contraste quelle que soit la teinte tirée.
const AV_HUE_FROM = 244;   // indigo de marque
const AV_HUE_TO = 350;     // corail de marque
const AV_STEPS = 12;       // nuances réparties sur l'arc
function avatarColor(addr) {
  const s = emailOnly(addr) || String(addr || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = AV_HUE_FROM + (h % AV_STEPS) * ((AV_HUE_TO - AV_HUE_FROM) / (AV_STEPS - 1));
  return `hsl(${Math.round(hue)} 58% 49%)`;
}

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
// Nettoie le HTML d'un mail avant affichage (le CSP bloque déjà les scripts ; les
// images data:/https sont autorisées pour afficher les signatures)
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
// base64url -> base64 standard (avec padding) pour data-URI / pièces jointes.
function b64urlToStd(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  return pad ? s + '='.repeat(4 - pad) : s;
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
