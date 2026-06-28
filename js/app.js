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
  sort: { key: 'dateEncaissement', dir: 'desc' }
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
  if (!b) return;
  let r; try { r = await window.api.gmail.unread(); } catch (_) { r = {}; }
  const n = (r && !r.error && r.count) ? r.count : 0;
  if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.classList.remove('hidden'); }
  else b.classList.add('hidden');
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

CC.switchTab = function (name) {
  // Onglets "Compta" exposes via le menu (dashboard/factures/fiscal) -> ouvrir Compta + sous-onglet
  if (name === 'dashboard' || name === 'factures' || name === 'fiscal' || name === 'donnees') {
    CC.switchTab('compta');
    CC.switchSub(name);
    return;
  }
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'compta') CC.switchSub(CC.state.subTab || 'dashboard');
  if (name === 'today' && CC.renderToday) CC.renderToday();
  if (name === 'agenda' && CC.agenda) CC.agenda.render();
  if (name === 'mails' && CC.mailbox) CC.mailbox.render();
  if (name === 'redaction' && CC.mailComposer) CC.mailComposer.render();
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
  CC.mailComposer.bind();
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
  bar.innerHTML = `<span class="dd-ic">⚠️</span><span>Disque externe non connecté — affichage en <b>lecture seule</b> de la copie locale (${when}).</span><button id="ddReconnect" class="btn">Reconnecter</button>`;
  bar.classList.add('show');
  document.body.classList.add('readonly');
  CC.updateDirtyUI();
  // Detection automatique du rebranchement (toutes les 5 s)
  clearInterval(CC._ddTimer);
  CC._ddTimer = setInterval(() => CC.tryReconnectDD(false), 5000);
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
