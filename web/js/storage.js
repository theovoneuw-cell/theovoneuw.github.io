'use strict';
window.CC = window.CC || {};

CC.FILE_VERSION = 2;

CC.storage = {
  serialize() {
    return JSON.stringify({
      version: CC.FILE_VERSION,
      settings: CC.state.settings,
      declarations: CC.state.declarations,
      factures: CC.state.factures,
      trajets: CC.state.trajets
    }, null, 2);
  },

  applyData(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('Fichier invalide');
    const s = Object.assign(CC.defaultSettings(), obj.settings || {});
    if (obj.settings && obj.settings.urssafRates) s.urssafRates = obj.settings.urssafRates;
    // Corrige la coquille "Anhit" -> "Anahit" sur une adresse de départ déjà enregistrée.
    if (s.adresseDepart) s.adresseDepart = s.adresseDepart.replace(/Anhit/g, 'Anahit');
    CC.state.settings = s;
    CC.state.declarations = obj.declarations || {};
    CC.state.factures = Array.isArray(obj.factures) ? obj.factures.map(normalize) : [];
    CC.state.trajets = Array.isArray(obj.trajets) ? obj.trajets : [];
    // Le pense-bête vit désormais dans son propre fichier Drive (notes.json).
    // On garde juste une graine de migration si un ancien fichier compta en contenait.
    if (Array.isArray(obj.notes) && obj.notes.length) CC.state._notesSeed = obj.notes;
  },

  async save(forceDialog) {
    if (CC.state.readOnly) { CC.toast('Lecture seule : rebranche le disque externe pour enregistrer.', 'err'); return false; }
    const res = await window.api.save(CC.storage.serialize(), !!forceDialog);
    if (res.canceled) return false;
    if (res.error) { CC.toast('Erreur d\'enregistrement : ' + res.error, 'err'); return false; }
    CC.state.dirty = false;
    CC.state.filePath = res.filePath;
    window.api.setFile(res.filePath);
    window.api.recoveryClear();
    CC.updateDirtyUI();
    CC.toast('Enregistré : ' + fileName(res.filePath), 'ok');
    return true;
  },

  async open() {
    if (!(await CC.confirmIfDirty())) return;
    const res = await window.api.open();
    if (res.canceled) return;
    if (res.error) { CC.toast('Erreur d\'ouverture : ' + res.error, 'err'); return; }
    try {
      CC.storage.applyData(JSON.parse(res.content));
      CC.state.filePath = res.filePath;
      CC.state.dirty = false;
      window.api.setFile(res.filePath);
      window.api.recoveryClear();
      CC.refreshYears();
      CC.renderSettings();
      CC.render();
      CC.updateDirtyUI();
      CC.toast('Fichier ouvert : ' + fileName(res.filePath), 'ok');
    } catch (e) {
      CC.toast('Fichier illisible : ' + e.message, 'err');
    }
  },

  async newFile() {
    if (!(await CC.confirmIfDirty())) return;
    CC.state.settings = CC.defaultSettings();
    CC.state.factures = [];
    CC.state.declarations = {};
    CC.state.trajets = [];
    CC.state.filePath = null;
    CC.state.dirty = false;
    window.api.setFile(null);
    window.api.recoveryClear();
    CC.refreshYears();
    CC.renderSettings();
    CC.render();
    CC.updateDirtyUI();
    CC.toast('Nouveau fichier créé.', 'ok');
  },

  async exportCsv() {
    const sep = ';';
    const head = ['Annee', 'Trimestre', 'Encaisse le', 'N° Facture', 'Libelle', 'Mode de paiement', 'Montant', 'Statut'];
    const lines = [head.join(sep)];
    const labels = { recue: 'Recue', attente: 'En attente', retard: 'En retard', prevu: 'Previsionnel' };
    CC.facturesView.current().forEach((f) => {
      const st = CC.stats.statut(f, CC.state.settings);
      const row = [
        CC.stats.yearOf(f) || '', 'T' + (CC.stats.trimOf(f) || ''),
        CC.util.frDate(f.dateEncaissement), f.numFacture || '',
        '"' + (f.libelle || '').replace(/"/g, '""') + '"',
        f.modePaiement || '', String(+f.montant || 0).replace('.', ','), labels[st]
      ];
      lines.push(row.join(sep));
    });
    const res = await window.api.exportCsv(lines.join('\r\n'));
    if (res && res.filePath) CC.toast('Export CSV : ' + fileName(res.filePath), 'ok');
  },

  async exportPdf() {
    // Génère un PDF épuré du bilan (HTML mis en page), pas une capture du logiciel.
    const year = (CC.bilan && CC.bilan.resolveYear) ? CC.bilan.resolveYear() : null;
    if (year == null) { CC.toast('Aucune donnée à exporter.', 'err'); return; }
    const html = CC.bilan.buildPrintHTML(year);
    const res = await window.api.exportBilanPdf({ html, defaultName: `bilan-${year}.pdf` });
    if (!res || res.canceled) return;
    if (res.error) { CC.toast('Export PDF impossible : ' + res.error, 'err'); return; }
    if (res.filePath) CC.toast('Bilan PDF : ' + fileName(res.filePath), 'ok');
  },

  async importExcel() {
    const res = await window.api.importExcel();
    if (res.canceled) return;
    if (res.error) { CC.toast('Erreur import : ' + res.error, 'err'); return; }
    try {
      const factures = CC.importer.fromBase64(res.base64);
      if (!factures.length) { CC.toast('Aucune facture détectée dans ce fichier.', 'err'); return; }
      const choix = await CC.dialog({
        type: 'question',
        buttons: ['Ajouter aux factures', 'Remplacer tout', 'Annuler'],
        defaultId: 0, cancelId: 2,
        title: 'Import Excel',
        message: `${factures.length} facture(s) détectée(s).`,
        detail: 'Voulez-vous les ajouter à vos factures existantes ou tout remplacer ?'
      });
      if (choix.response === 2) return;
      if (choix.response === 1) CC.state.factures = factures;
      else CC.state.factures = CC.state.factures.concat(factures);
      CC.markDirty();
      CC.refreshYears();
      CC.renderSettings();
      CC.render();
      CC.toast(`${factures.length} facture(s) importée(s).`, 'ok');
    } catch (e) {
      CC.toast('Import impossible : ' + e.message, 'err');
    }
  },

  // Sauvegarde de recuperation (debounce)
  scheduleRecovery() {
    clearTimeout(CC._recoveryTimer);
    CC._recoveryTimer = setTimeout(() => {
      window.api.recoveryWrite(CC.storage.serialize());
    }, 1500);
  }
};

function normalize(f) {
  // Compat ancien format (v1) : "date" = date de vente marquee payee
  let annee = f.annee, trimestre = f.trimestre;
  if (!annee && f.dateEncaissement) annee = CC.util.yearOf(f.dateEncaissement);
  if (!annee && f.date) annee = CC.util.yearOf(f.date);
  if (!trimestre && f.dateEncaissement) trimestre = CC.util.trimestreOfDate(f.dateEncaissement);
  if (!trimestre && f.date) trimestre = CC.util.trimestreOfDate(f.date);
  return {
    id: f.id || CC.util.uid(),
    libelle: f.libelle || '',
    montant: +f.montant || 0,
    numFacture: f.numFacture || '',
    modePaiement: f.modePaiement || '',
    dateEncaissement: f.dateEncaissement || '',
    annee: annee || null,
    trimestre: trimestre || null,
    categorie: f.categorie || (CC.util.categoryOf ? CC.util.categoryOf(f.libelle) : 'Autre'),
    dateEnvoi: f.dateEnvoi || '',
    dateEcheance: f.dateEcheance || '',
    notes: f.notes || '',
    fichier: f.fichier || ''
  };
}
function fileName(p) { return p ? p.split(/[\\/]/).pop() : ''; }
