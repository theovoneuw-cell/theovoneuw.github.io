'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Etat global
// ---------------------------------------------------------------------------
CC.state = {
  settings: CC.defaultSettings(),
  factures: [],
  declarations: {},
  trajets: [],
  notes: [],            // pense-bête (synchronisé PC ↔ iPhone via le document)
  filePath: null,
  primaryPath: null,    // chemin habituel du fichier (sur le disque externe)
  readOnly: false,      // true quand on affiche la copie locale (disque absent)
  privacy: false,       // true = mode discret (chiffres masqués par •••)
  dirty: false,
  selectedYear: new Date().getFullYear(),
  filters: { search: '', status: 'all', trimestre: 'all', categorie: 'all', pj: 'all' },
  // Par défaut : les factures à relancer (retard puis en attente) en haut.
  sort: { key: 'statut', dir: 'asc' }
};

// ---------------------------------------------------------------------------
// Helpers globaux exposes aux autres modules
// ---------------------------------------------------------------------------
CC.markDirty = function () {
  CC.state.dirty = true;
  CC.updateDirtyUI();
  CC.storage.scheduleRecovery();
};

CC.updateDirtyUI = function () {
  window.api.setDirty(CC.state.dirty);
  const btn = document.getElementById('btnSave');
  if (CC.state.readOnly) {
    btn.textContent = 'Lecture seule';
    btn.disabled = true;
  } else {
    btn.disabled = false;
    btn.textContent = CC.state.dirty ? 'Enregistrer •' : 'Enregistrer';
  }
};

CC.render = function () {
  CC.renderDashboard();
  CC.facturesView.render();
  CC.renderFiscal();
};

// Ouvre une piece jointe (PDF) avec l'application par defaut du systeme
CC.openPj = async function (filePath) {
  if (!filePath) { CC.toast('Aucune pièce jointe.', 'err'); return; }
  const res = await window.api.openPath(filePath);
  if (res && res.error) CC.toast('Impossible d\'ouvrir : ' + res.error, 'err');
};

// ---------------------------------------------------------------------------
// Boîte de dialogue intégrée à l'UI (remplace les fenêtres natives Windows).
// Même forme de retour que l'API Electron : Promise<{ response, checkboxChecked }>.
// ---------------------------------------------------------------------------
CC.dialog = function (opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const buttons = (opts.buttons && opts.buttons.length) ? opts.buttons : ['OK'];
    const defaultId = (opts.defaultId != null) ? opts.defaultId : 0;
    const cancelId = (opts.cancelId != null) ? opts.cancelId : (buttons.length > 1 ? buttons.length - 1 : 0);
    const icons = { warning: '!', error: '✕', question: '?', info: 'i' };
    const icon = icons[opts.type] || '';

    let back = document.getElementById('appDialog');
    if (!back) {
      back = document.createElement('div');
      back.id = 'appDialog';
      back.className = 'dlg-backdrop hidden';
      document.body.appendChild(back);
    }
    const btnHtml = buttons.map((b, i) =>
      `<button class="btn${i === defaultId ? ' btn-primary' : ''}" data-dlg="${i}">${escDlg(b)}</button>`
    ).join('');
    back.innerHTML = `
      <div class="dlg" role="dialog" aria-modal="true">
        <div class="dlg-head">
          <span class="dlg-title">${escDlg(opts.title || '')}</span>
          <button class="dlg-x" data-dlg="${cancelId}" title="Fermer" aria-label="Fermer">✕</button>
        </div>
        <div class="dlg-body">
          ${icon ? `<div class="dlg-ic dlg-ic-${opts.type || 'info'}">${icon}</div>` : ''}
          <div class="dlg-texts">
            ${opts.message ? `<div class="dlg-msg">${escDlg(opts.message)}</div>` : ''}
            ${opts.detail ? `<div class="dlg-detail">${escDlg(opts.detail).replace(/\n/g, '<br>')}</div>` : ''}
            ${opts.input ? `<input id="dlgInput" class="input dlg-input" type="${escDlg(opts.input.type || 'text')}" placeholder="${escDlg(opts.input.placeholder || '')}" autocomplete="off" />` : ''}
          </div>
        </div>
        <div class="dlg-actions">${btnHtml}</div>
      </div>`;
    back.classList.remove('hidden');

    const getVal = () => { const el = document.getElementById('dlgInput'); return el ? el.value : undefined; };
    const finish = (i) => {
      const value = getVal();
      back.classList.add('hidden');
      back.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve({ response: i, checkboxChecked: false, value });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(cancelId); }
      else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); finish(defaultId); }
    };
    back.onclick = (e) => {
      const b = e.target.closest('[data-dlg]');
      if (b) { finish(parseInt(b.dataset.dlg, 10)); return; }
      if (e.target === back) finish(cancelId);
    };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => {
      const focusEl = opts.input ? document.getElementById('dlgInput') : back.querySelector(`[data-dlg="${defaultId}"]`);
      if (focusEl) focusEl.focus();
    }, 30);
  });
};

function escDlg(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

CC.toast = function (msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || '');
  t.classList.remove('hidden');
  clearTimeout(CC._toastTimer);
  CC._toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
};

// Badge "non lus" sur l'onglet Mails (silencieux si Google non connecté)
CC.updateMailBadge = async function () {
  const b = document.getElementById('mailsBadge');
  const mb = document.getElementById('mMailsBadge');   // miroir dans la barre du bas (mobile)
  if (!b && !mb) return;
  let r; try { r = await window.api.gmail.unread(); } catch (_) { r = {}; }
  const n = (r && !r.error && r.count) ? r.count : 0;
  const txt = n > 99 ? '99+' : String(n);
  // Compteur du dossier "Boîte de réception" dans le rail des mails (comme Gmail)
  const fc = document.getElementById('gmInboxCount');
  if (fc) {
    if (n > 0) { fc.textContent = txt; fc.classList.remove('hidden'); }
    else fc.classList.add('hidden');
  }
  [b, mb].forEach((el) => {
    if (!el) return;
    if (n > 0) { el.textContent = txt; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  });
};

// Reconstruit la liste des annees dans le selecteur
CC.refreshYears = function () {
  const sel = document.getElementById('yearSelect');
  const years = CC.stats.years(CC.state.factures);
  const cur = new Date().getFullYear();
  if (!years.includes(cur)) years.push(cur);
  years.sort((a, b) => b - a);

  // Conserver la selection si toujours valide
  let selected = CC.state.selectedYear;
  if (selected !== 'all' && !years.includes(selected)) selected = years[0] || cur;
  CC.state.selectedYear = selected;

  sel.innerHTML = '<option value="all">Toutes les années</option>' +
    years.map((y) => `<option value="${y}">${y}</option>`).join('');
  sel.value = String(selected);
};

CC.state.subTab = 'dashboard';   // sous-onglet actif dans Compta

CC.switchTab = function (name, dir) {
  // Onglets "Compta" exposes via le menu (dashboard/factures/fiscal) -> ouvrir Compta + sous-onglet
  if (name === 'dashboard' || name === 'factures' || name === 'fiscal' || name === 'donnees') {
    CC.switchTab('compta');
    CC.switchSub(name);
    return;
  }
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  // Animation directionnelle si on arrive par un swipe (dir = 'next' | 'prev').
  const activePanel = document.getElementById('tab-' + name);
  if (activePanel) {
    activePanel.classList.remove('slide-next', 'slide-prev');
    if (dir) { void activePanel.offsetWidth; activePanel.classList.add(dir === 'next' ? 'slide-next' : 'slide-prev'); }
  }
  // Barre de navigation mobile : synchro de l'état actif + fermeture de la feuille "Plus".
  const MOBILE_PRIMARY = ['today', 'compta', 'agenda', 'mails'];
  document.querySelectorAll('.mtab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.msheet-item[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  const more = document.getElementById('mMore');
  if (more) more.classList.toggle('active', MOBILE_PRIMARY.indexOf(name) === -1);
  if (CC.closeMoreSheet) CC.closeMoreSheet();
  if (name === 'compta') CC.switchSub(CC.state.subTab || 'dashboard');
  if (name === 'today' && CC.renderToday) CC.renderToday();
  if (name === 'agenda' && CC.agenda) CC.agenda.render();
  if (name === 'mails' && CC.mailbox) CC.mailbox.render();
  if (name === 'redaction' && CC.ai) CC.ai.render();
  if (name === 'trajets' && CC.trajets) CC.trajets.render();
  if (name === 'settings' && CC.connections) CC.connections.render();
};

// Sous-onglets de la partie Compta
CC.switchSub = function (sub) {
  CC.state.subTab = sub;
  document.querySelectorAll('.subtab').forEach((t) => t.classList.toggle('active', t.dataset.sub === sub));
  document.querySelectorAll('.subpanel').forEach((p) => p.classList.toggle('active', p.id === 'sub-' + sub));
  if (sub === 'dashboard') CC.renderDashboard();
  if (sub === 'factures') CC.facturesView.render();
  if (sub === 'fiscal') CC.renderFiscal();
  if (sub === 'bilan' && CC.renderBilan) CC.renderBilan();
};

CC.confirmIfDirty = async function () {
  if (!CC.state.dirty) return true;
  const choix = await CC.dialog({
    type: 'warning',
    buttons: ['Enregistrer', 'Continuer sans enregistrer', 'Annuler'],
    defaultId: 0, cancelId: 2,
    title: 'Modifications non enregistrées',
    message: 'Vous avez des modifications non enregistrées.',
    detail: 'Que voulez-vous faire ?'
  });
  if (choix.response === 2) return false;        // Annuler
  if (choix.response === 0) return await CC.storage.save(false);  // Enregistrer
  return true;                                    // Continuer sans enregistrer
};

// Confirmation de fermeture (déclenchée par le process principal) — affichée dans l'UI.
CC.confirmClose = async function () {
  const choix = await CC.dialog({
    type: 'warning',
    buttons: ['Enregistrer et quitter', 'Quitter sans enregistrer', 'Annuler'],
    defaultId: 0, cancelId: 2,
    title: 'Modifications non enregistrées',
    message: 'Vous avez des modifications non enregistrées.',
    detail: 'Voulez-vous les enregistrer avant de quitter ?'
  });
  if (choix.response === 2) return;                       // Annuler : on reste
  if (choix.response === 0) {
    const ok = await CC.storage.save(false);
    if (!ok) return;                                      // échec/annulation de sauvegarde : on reste
  }
  window.api.forceClose();                                // quitte réellement
};

// ---------------------------------------------------------------------------
// Navigation mobile : barre d'onglets en bas + feuille "Plus" + swipe entre onglets.
// Tout est inerte sur desktop (la barre est masquée en CSS ; le swipe ne s'active
// qu'en dessous de 720px de large).
// ---------------------------------------------------------------------------
CC.openMoreSheet = function () { const s = document.getElementById('moreSheet'); if (s) s.classList.remove('hidden'); };
CC.closeMoreSheet = function () { const s = document.getElementById('moreSheet'); if (s) s.classList.add('hidden'); };

CC.initMobileNav = function () {
  // Anti-zoom : en plus du meta viewport (user-scalable=no), on bloque le pinch-zoom
  // iOS (événements 'gesture*' propres à Safari) et le double-tap zoom.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => {
    document.addEventListener(ev, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  });
  // Clic sur une icône de la barre ou un item de la feuille -> change d'onglet.
  document.querySelectorAll('.mtab[data-tab], .msheet-item[data-tab]').forEach((b) => {
    b.addEventListener('click', () => CC.switchTab(b.dataset.tab));
  });
  const more = document.getElementById('mMore');
  if (more) more.addEventListener('click', () => CC.openMoreSheet());
  // Fermeture de la feuille : clic sur le fond ou tout élément [data-close].
  const sheet = document.getElementById('moreSheet');
  if (sheet) sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === sheet) CC.closeMoreSheet(); });

  // --- Swipe horizontal pour changer d'onglet (téléphone uniquement) ---
  // Le panneau actif suit légèrement le doigt (retour tactile), puis à la validation
  // le nouvel onglet entre en glissant depuis le côté du geste.
  const main = document.querySelector('main');
  if (!main) return;
  // Zones à ignorer : elles gèrent leur propre défilement/geste horizontal.
  const EXCLUDE = '.leaflet-container, .table-wrap, .chart-box, .subtabs, .dp, input, textarea, select, .mobile-sheet';
  let x0 = null, y0 = null, tracking = false, dragPanel = null, horiz = false;
  let edgeLeft = false, edgeRight = false;

  // Ordre des onglets = celui des onglets visibles du haut (les masqués sont exclus).
  function tabOrder() {
    return Array.prototype.slice.call(document.querySelectorAll('.tab[data-tab]'))
      .filter((tb) => !tb.classList.contains('hidden')).map((tb) => tb.dataset.tab);
  }

  function clearDrag(animateBack) {
    if (!dragPanel) return;
    const p = dragPanel; dragPanel = null;
    p.classList.remove('dragging');
    if (animateBack) {
      // Retour en place sur une courbe élastique douce plutôt qu'un `ease` plat.
      p.style.transition = 'transform .34s cubic-bezier(.22,1.2,.36,1), opacity .24s ease';
      p.style.transform = 'translateX(0) scale(1)'; p.style.opacity = '1';
      setTimeout(() => { p.style.transition = ''; p.style.transform = ''; p.style.opacity = ''; }, 350);
    } else {
      p.style.transition = ''; p.style.transform = ''; p.style.opacity = '';
    }
  }

  main.addEventListener('touchstart', (e) => {
    if (window.innerWidth > 720 || !e.touches || e.touches.length !== 1) { tracking = false; return; }
    if (e.target.closest(EXCLUDE)) { tracking = false; return; }
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; tracking = true; horiz = false; dragPanel = null;
  }, { passive: true });

  // touchmove NON passif : une fois le geste reconnu comme horizontal, on bloque le
  // défilement vertical de la page (preventDefault) pour un slide net, sans à-coups.
  main.addEventListener('touchmove', (e) => {
    if (!tracking || x0 == null || !e.touches || !e.touches.length) return;
    const t = e.touches[0]; const dx = t.clientX - x0, dy = t.clientY - y0;
    if (!horiz) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;      // direction pas encore décidée
      // Seuil : franchement horizontal (dx dominant) pour verrouiller ; sinon on laisse scroller.
      if (Math.abs(dx) <= Math.abs(dy) * 1.2) { tracking = false; return; }   // geste vertical -> scroll normal
      horiz = true;
      dragPanel = document.querySelector('.panel.active');
      if (dragPanel) dragPanel.classList.add('dragging');
      // On mémorise s'il existe un onglet de chaque côté : sans voisin, le geste
      // doit « résister » au lieu de glisser normalement pour revenir bredouille.
      const ord = tabOrder();
      const i = ord.findIndex((n) => { const p = document.getElementById('tab-' + n); return p && p.classList.contains('active'); });
      edgeLeft = i <= 0;                    // pas d'onglet précédent
      edgeRight = i < 0 || i >= ord.length - 1;   // pas d'onglet suivant
    }
    // Geste horizontal verrouillé : on empêche le scroll vertical de la page.
    if (e.cancelable) e.preventDefault();
    if (!dragPanel) return;
    // Élastique de bout de course (comme iOS) : au premier ou au dernier onglet,
    // le panneau ne suit le doigt qu'au tiers et bute vite — on sent le bord.
    const atEdge = (dx > 0 && edgeLeft) || (dx < 0 && edgeRight);
    const factor = atEdge ? 0.16 : 0.42;
    const limit = atEdge ? 26 : 72;
    const damp = Math.max(-limit, Math.min(limit, dx * factor));
    // Léger recul en profondeur pendant le glissement : la page semble se
    // décoller avant de céder la place à la suivante.
    const depth = atEdge ? 1 : 1 - Math.min(0.014, Math.abs(damp) / 5200);
    dragPanel.style.transform = 'translateX(' + damp + 'px) scale(' + depth.toFixed(4) + ')';
    dragPanel.style.opacity = String(1 - Math.min(0.22, Math.abs(damp) / 320));
  }, { passive: false });

  main.addEventListener('touchend', (e) => {
    const wasTracking = tracking; tracking = false;
    if (!wasTracking || x0 == null) { clearDrag(false); return; }
    const t = (e.changedTouches && e.changedTouches[0]);
    if (!t) { clearDrag(true); return; }
    const dx = t.clientX - x0, dy = t.clientY - y0;
    const commit = Math.abs(dx) >= 70 && Math.abs(dx) > Math.abs(dy) * 1.5;
    if (!commit) { clearDrag(true); return; }
    const order = tabOrder();
    const cur = order.findIndex((n) => { const p = document.getElementById('tab-' + n); return p && p.classList.contains('active'); });
    const next = dx < 0 ? cur + 1 : cur - 1;   // glisser vers la gauche = onglet suivant
    if (cur < 0 || next < 0 || next >= order.length) { clearDrag(true); return; }   // pas de bouclage
    clearDrag(false);   // l'ancien panneau va être masqué : on nettoie sans animer
    CC.switchTab(order[next], dx < 0 ? 'next' : 'prev');
  }, { passive: true });

  main.addEventListener('touchcancel', () => { tracking = false; clearDrag(true); }, { passive: true });
};

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------
async function init() {
  // Onglets principaux
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => CC.switchTab(tab.dataset.tab));
  });
  // Sous-onglets (Compta)
  document.querySelectorAll('.subtab').forEach((tab) => {
    tab.addEventListener('click', () => CC.switchSub(tab.dataset.sub));
  });

  // Barre de navigation mobile (bas d'écran) + feuille "Plus"
  CC.initMobileNav();

  // Selecteur d'annee
  document.getElementById('yearSelect').addEventListener('change', (e) => {
    CC.state.selectedYear = e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10);
    CC.render();
  });

  // Bouton enregistrer
  document.getElementById('btnSave').addEventListener('click', () => CC.storage.save(false));

  // Boutons onglet Parametres
  document.getElementById('btnImportExcel').addEventListener('click', () => CC.storage.importExcel());
  document.getElementById('btnExportCsv').addEventListener('click', () => CC.storage.exportCsv());
  document.getElementById('btnExportPdf').addEventListener('click', () => CC.storage.exportPdf());

  // Bilan annuel : sélecteur d'année + export PDF
  const bilanYear = document.getElementById('bilanYear');
  if (bilanYear) bilanYear.addEventListener('change', (e) => { CC.bilan._year = parseInt(e.target.value, 10); CC.renderBilan(); });
  const bilanExport = document.getElementById('bilanExport');
  if (bilanExport) bilanExport.addEventListener('click', () => CC.storage.exportPdf());

  CC.bindSettings();
  CC.facturesView.bind();
  if (CC.ai) CC.ai.bind();
  CC.connections.bind();
  CC.agenda.bind();
  if (CC.mailbox) CC.mailbox.bind();
  if (CC.trajets) CC.trajets.bind();
  if (CC.notes) CC.notes.bind();
  if (CC.privacy) CC.privacy.bind();
  CC.installReadOnlyGuard();

  // Actions du menu (process principal)
  window.api.onMenu(async (channel, payload) => {
    switch (channel) {
      case 'menu:new': return CC.storage.newFile();
      case 'menu:open': return CC.storage.open();
      case 'menu:save': return CC.storage.save(false);
      case 'menu:save-as': return CC.storage.save(true);
      case 'menu:save-then-quit':
        if (await CC.storage.save(false)) window.close();
        break;
      case 'menu:import-excel': return CC.storage.importExcel();
      case 'menu:export-csv': return CC.storage.exportCsv();
      case 'menu:export-pdf': return CC.storage.exportPdf();
      case 'menu:new-facture': return CC.facturesView.openModal(null);
      case 'menu:tab': return CC.switchTab(payload);
      case 'app:confirm-close': return CC.confirmClose();
    }
  });

  // Raccourci clavier Echap pour fermer la modale facture
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') CC.facturesView.closeModal();
  });

  // Chargement automatique du dernier fichier utilise (ou du fichier par defaut)
  await loadStartupFile();

  CC.renderSettings();
  CC.refreshYears();
  CC.render();
  CC.updateDirtyUI();
  CC.connections.render();   // statut des connexions + prefs mail
  CC.renderToday();          // cockpit d'accueil (onglet par defaut)
  if (CC.privacy) CC.privacy.afterLoad();   // icône œil + statut carte "Mode discret"

  // Badge des mails non lus : au démarrage puis toutes les 2 minutes
  CC.updateMailBadge();
  setInterval(() => CC.updateMailBadge(), 120000);

  // Pense-bête : récupère la version Drive (synchro PC ↔ iPhone)
  if (CC.notes) CC.notes.pull();

  // Proposer la recuperation si une sauvegarde de secours existe
  checkRecovery();
}

// Charge sans dialogue le fichier de demarrage fourni par le process principal
async function loadStartupFile() {
  try {
    const res = await window.api.startup();
    if (!res || !res.content) return;
    CC.storage.applyData(JSON.parse(res.content));
    CC.state.filePath = res.filePath;
    CC.state.dirty = false;
    CC.state.primaryPath = res.primaryPath || res.filePath || null;

    // Mode discret au démarrage : on masque AVANT le premier rendu (aucun flash).
    if (res.privacyStartup) {
      CC.state.privacy = true;
      document.body.classList.add('privacy');
    }

    if (res.offline) {
      // Disque externe absent : on affiche la copie locale en lecture seule.
      CC.state.readOnly = true;
      window.api.setFile(null);
      CC.showOfflineBanner(res.mirrorUpdatedAt);
      CC.toast('Disque externe absent — données locales en lecture seule.', 'err');
    } else {
      CC.state.readOnly = false;
      window.api.setFile(res.filePath);
      CC.toast('Fichier chargé : ' + (res.filePath ? res.filePath.split(/[\\/]/).pop() : ''), 'ok');
    }
  } catch (e) {
    CC.toast('Chargement auto impossible : ' + e.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Mode hors-ligne (disque externe debranche) : lecture seule + reconnexion
// ---------------------------------------------------------------------------
CC.showOfflineBanner = function (mirrorUpdatedAt) {
  let bar = document.getElementById('ddBanner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ddBanner';
    document.body.prepend(bar);
    bar.addEventListener('click', (e) => { if (e.target.closest('#ddReconnect')) CC.tryReconnectDD(true); });
  }
  const when = mirrorUpdatedAt
    ? new Date(mirrorUpdatedAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'dernière sauvegarde';
  bar.innerHTML = `<span class="dd-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg></span><span>Disque externe non connecté — affichage en <b>lecture seule</b> de la copie locale (${when}).</span><button id="ddReconnect" class="btn">Reconnecter</button>`;
  bar.classList.add('show');
  document.body.classList.add('readonly');
  CC.updateDirtyUI();
  // Detection automatique du rebranchement (toutes les 5 s)
  clearInterval(CC._ddTimer);
  CC._ddTimer = setInterval(() => CC.tryReconnectDD(false), 5000);
};

// ---------------------------------------------------------------------------
// Reconnexion à Google quand la session (~1 h) a expiré. Sur iPhone, le jeton
// web ne se renouvelle pas toujours en silence : Gmail/Agenda tombent alors que
// le réseau (et Gemini) marchent. Ce bouton relance le consentement (À APPELER
// DANS un geste de clic : Safari ouvre le popup de façon synchrone), puis
// rafraîchit les vues dépendantes de Google.
// ---------------------------------------------------------------------------
CC.reconnectGoogle = function (btn) {
  let orig = '';
  if (btn) { orig = btn.textContent; btn.disabled = true; btn.textContent = 'Connexion…'; }
  let p;
  try { p = window.api.gcal.connect(); }        // appel SYNCHRONE (indispensable Safari/iPhone)
  catch (e) { p = Promise.reject(e); }
  Promise.resolve(p)
    .then((r) => {
      if (r && r.error) CC.toast('Reconnexion Google impossible : ' + r.error, 'err');
      else CC.toast('Google reconnecté ✓', 'ok');
    })
    .catch(() => CC.toast('Reconnexion Google impossible.', 'err'))
    .finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
      try { if (CC.agenda && CC.agenda.render) CC.agenda.render(); } catch (_) {}
      try { if (CC.renderToday) CC.renderToday(); } catch (_) {}
      try { if (CC.mailbox && CC.mailbox.render) CC.mailbox.render(); } catch (_) {}
      try { if (CC.updateMailBadge) CC.updateMailBadge(); } catch (_) {}
    });
};

CC.tryReconnectDD = async function (manual) {
  if (!CC.state.primaryPath) return;
  let r;
  try { r = await window.api.ddCheck(CC.state.primaryPath); } catch (_) { return; }
  if (!r || !r.available) { if (manual) CC.toast('Disque externe toujours non détecté.', 'err'); return; }

  // Disque revenu : on recharge le fichier principal et on réactive l'édition.
  let rd;
  try { rd = await window.api.read(CC.state.primaryPath); } catch (_) { return; }
  if (!rd || rd.error || !rd.content) { if (manual) CC.toast('Disque détecté mais fichier illisible.', 'err'); return; }
  try { CC.storage.applyData(JSON.parse(rd.content)); } catch (_) { if (manual) CC.toast('Fichier illisible.', 'err'); return; }

  clearInterval(CC._ddTimer);
  CC.state.readOnly = false;
  CC.state.filePath = CC.state.primaryPath;
  CC.state.dirty = false;
  window.api.setFile(CC.state.primaryPath);
  document.body.classList.remove('readonly');
  const bar = document.getElementById('ddBanner');
  if (bar) bar.classList.remove('show');
  CC.refreshYears();
  CC.renderSettings();
  CC.render();
  CC.updateDirtyUI();
  if (CC.renderToday) CC.renderToday();
  CC.toast('Disque reconnecté ✓ Données à jour, édition réactivée.', 'ok');
};

// Empeche toute action de modification quand on est en lecture seule (hors DD).
CC.installReadOnlyGuard = function () {
  const allowed = (t) =>
    t.closest('.tab, .subtab, #ddBanner, #tab-mails, #mailModal, #tab-redaction, #tab-agenda, #tab-settings, .leaflet-container, .ac-list') ||
    t.closest('#yearSelect, #btnExportCsv, #btnExportPdf, #bilanExport, #bilanYear, #tj_calc, #mailRefresh');
  document.addEventListener('click', (e) => {
    if (!CC.state.readOnly) return;
    const t = e.target.closest('button, .mini-btn, [data-del]');
    if (!t || allowed(t)) return;
    e.preventDefault();
    e.stopPropagation();
    CC.toast('Lecture seule : rebranche le disque externe pour modifier.', 'err');
  }, true);
};

async function checkRecovery() {
  if (CC.state.readOnly) return;   // pas de récupération en mode lecture seule (disque absent)
  try {
    const res = await window.api.recoveryRead();
    if (!res || !res.content) return;
    const obj = JSON.parse(res.content);
    if (!obj.factures || !obj.factures.length) { window.api.recoveryClear(); return; }
    const choix = await CC.dialog({
      type: 'question',
      buttons: ['Récupérer', 'Ignorer'],
      defaultId: 0, cancelId: 1,
      title: 'Récupération',
      message: 'Une sauvegarde de secours a été trouvée.',
      detail: `Elle contient ${obj.factures.length} facture(s). Voulez-vous la récupérer ?`
    });
    if (choix.response === 0) {
      CC.storage.applyData(obj);
      CC.state.dirty = true;
      CC.refreshYears();
      CC.renderSettings();
      CC.render();
      CC.updateDirtyUI();
      CC.toast('Données récupérées. Pensez à enregistrer (Ctrl+S).', 'ok');
    } else {
      window.api.recoveryClear();
    }
  } catch (_) { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', init);
