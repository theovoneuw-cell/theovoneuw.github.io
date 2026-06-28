'use strict';
window.CC = window.CC || {};

CC.facturesView = {
  current() {
    const S = CC.state;
    let list = CC.stats.forYear(S.factures, S.selectedYear);
    const f = S.filters;
    if (f.status !== 'all') list = list.filter((x) => CC.stats.statut(x, S.settings) === f.status);
    if (f.trimestre !== 'all') list = list.filter((x) => CC.stats.trimOf(x) === parseInt(f.trimestre, 10));
    if (f.categorie && f.categorie !== 'all') list = list.filter((x) => (x.categorie || CC.util.categoryOf(x.libelle)) === f.categorie);
    if (f.pj === 'with') list = list.filter((x) => !!x.fichier);
    else if (f.pj === 'without') list = list.filter((x) => !x.fichier);
    if (f.search) {
      const q = f.search.toLowerCase();
      list = list.filter((x) => (x.libelle || '').toLowerCase().includes(q) || (x.numFacture || '').toLowerCase().includes(q) || (x.modePaiement || '').toLowerCase().includes(q));
    }
    const { key, dir } = S.sort;
    const mul = dir === 'asc' ? 1 : -1;
    // Priorité de statut : ce qui est à relancer d'abord (retard, puis attente).
    const STATUT_RANK = { retard: 0, attente: 1, prevu: 2, recue: 3 };
    list.sort((a, b) => {
      let va, vb;
      if (key === 'montant') { va = +a.montant; vb = +b.montant; }
      else if (key === 'statut') { va = STATUT_RANK[CC.stats.statut(a, S.settings)] ?? 9; vb = STATUT_RANK[CC.stats.statut(b, S.settings)] ?? 9; }
      else if (key === 'periode') { va = (CC.stats.yearOf(a) || 0) * 10 + (CC.stats.trimOf(a) || 0); vb = (CC.stats.yearOf(b) || 0) * 10 + (CC.stats.trimOf(b) || 0); }
      else { va = (a[key] || '').toString().toLowerCase(); vb = (b[key] || '').toString().toLowerCase(); }
      if (va < vb) return -mul; if (va > vb) return mul;
      // Départage : échéance/encaissement le plus récent d'abord.
      const da = a.dateEcheance || a.dateEncaissement || '', db = b.dateEcheance || b.dateEncaissement || '';
      return db.localeCompare(da);
    });
    return list;
  },

  render() {
    const S = CC.state;
    const list = CC.facturesView.current();
    const body = document.getElementById('facturesBody');
    const labels = { recue: 'Reçue', attente: 'En attente', retard: 'En retard', prevu: 'Prévisionnel' };
    let total = 0, enc = 0;

    body.innerHTML = list.map((f) => {
      const st = CC.stats.statut(f, S.settings);
      total += +f.montant || 0;
      if (st === 'recue') enc += +f.montant || 0;
      const y = CC.stats.yearOf(f), t = CC.stats.trimOf(f);
      const periode = y ? `${y}${t ? ' · T' + t : ''}` : '—';
      // "Marquer reçue" pour les factures emises non payees ; pour une previsionnelle, "Marquer émise"
      let quick = '';
      if (st === 'attente' || st === 'retard') quick = `<button class="mini-btn go-green" data-act="recue" data-id="${f.id}" title="Marquer comme reçue">Reçue ✓</button> `;
      else if (st === 'prevu') quick = `<button class="mini-btn" data-act="emise" data-id="${f.id}" title="Donner un n° = facture émise">Émise</button> `;
      const pj = f.fichier ? `<button class="mini-btn pj-btn" data-act="pj" data-id="${f.id}" title="Ouvrir la facture PDF" aria-label="Ouvrir la facture PDF">${ICON_CLIP}</button> ` : '';
      return `<tr class="frow ${st}">
        <td class="fdate" data-label="Encaissé le">${f.dateEncaissement ? CC.util.frDate(f.dateEncaissement) : '<span class="muted">—</span>'}</td>
        <td class="fmeta" data-label="Période">${periode}</td>
        <td class="fmeta" data-label="N°">${esc(f.numFacture) || '<span class="muted">—</span>'}</td>
        <td class="client" data-label="Client">${esc(f.libelle)} <span class="cat-chip">${esc(f.categorie || CC.util.categoryOf(f.libelle))}</span></td>
        <td class="num montant" data-label="Montant">${CC.util.eur(+f.montant || 0)}</td>
        <td data-label="Statut"><span class="stpill ${st}">${labels[st]}</span></td>
        <td class="col-actions">${pj}${quick}<button class="mini-btn" data-act="edit" data-id="${f.id}">Éditer</button></td>
      </tr>`;
    }).join('');

    document.getElementById('facturesEmpty').classList.toggle('hidden', list.length > 0);
    const sums = CC.stats.sums(list, S.settings);
    const prevuTxt = sums.prevu > 0 ? ` · Prévisionnel ${CC.util.eur0(sums.prevu)}` : '';
    document.getElementById('facturesSummary').textContent =
      `${list.length} facture(s) — Total ${CC.util.eur0(total)} · Encaissé ${CC.util.eur0(enc)}${prevuTxt}`;
  },

  openModal(facture) {
    const e = facture || {};
    const isEdit = !!facture;
    document.getElementById('modalTitle').textContent = isEdit ? 'Modifier la facture' : 'Nouvelle facture';
    document.getElementById('f_id').value = isEdit ? e.id : '';
    document.getElementById('f_libelle').value = e.libelle || '';
    document.getElementById('f_montant').value = isEdit ? e.montant : '';
    document.getElementById('f_numFacture').value = e.numFacture || '';
    document.getElementById('f_modePaiement').value = e.modePaiement || '';
    document.getElementById('f_categorie').value = e.categorie || (e.libelle ? CC.util.categoryOf(e.libelle) : 'Autre');
    const now = new Date();
    document.getElementById('f_annee').value = e.annee || now.getFullYear();
    document.getElementById('f_trimestre').value = e.trimestre || (Math.floor(now.getMonth() / 3) + 1);
    document.getElementById('f_recue').checked = !!e.dateEncaissement;
    document.getElementById('f_dateEncaissement').value = e.dateEncaissement || '';
    document.getElementById('f_dateEnvoi').value = e.dateEnvoi || '';
    document.getElementById('f_dateEcheance').value = e.dateEcheance || '';
    document.getElementById('f_notes').value = e.notes || '';
    CC.facturesView.setPj(e.fichier || '');
    document.getElementById('btnDeleteFacture').classList.toggle('hidden', !isEdit);
    document.getElementById('modalFacture').classList.remove('hidden');
    document.getElementById('f_libelle').focus();
  },

  // Affiche / masque la zone piece jointe
  setPj(filePath) {
    document.getElementById('f_fichier').value = filePath || '';
    const box = document.getElementById('pjFile');
    if (filePath) {
      document.getElementById('pjName').textContent = filePath.split(/[\\/]/).pop();
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }
  },

  // Lit le PDF choisi et pre-remplit le formulaire
  async importPj(file) {
    if (!file) return;
    CC.facturesView.setPj(file.path || file.name);
    try {
      const buf = await file.arrayBuffer();
      const r = await CC.pdfImporter.fromArrayBuffer(buf);
      if (r.libelle) document.getElementById('f_libelle').value = r.libelle;
      if (r.montant != null) document.getElementById('f_montant').value = r.montant;
      if (r.num) document.getElementById('f_numFacture').value = r.num;
      if (r.dateEnvoi) {
        document.getElementById('f_dateEnvoi').value = r.dateEnvoi;
        const env = CC.util.parseDate(r.dateEnvoi);
        if (env) document.getElementById('f_dateEcheance').value = CC.util.toISO(CC.util.addDays(env, r.echeanceJours || 30));
      }
      // Mode de paiement par defaut (Indy = virement / IBAN)
      if (!document.getElementById('f_modePaiement').value) document.getElementById('f_modePaiement').value = 'Virement';
      // Categorie automatique d'apres le libelle
      const lib = document.getElementById('f_libelle').value;
      if (lib) document.getElementById('f_categorie').value = CC.util.categoryOf(lib);

      if (r.isIndy) CC.toast('Facture PDF lue : ' + (r.libelle || r.num || ''), 'ok');
      else CC.toast('PDF joint, mais format non reconnu — vérifiez les champs.', 'err');
    } catch (err) {
      CC.toast('Lecture du PDF impossible : ' + err.message, 'err');
    }
  },

  closeModal() { document.getElementById('modalFacture').classList.add('hidden'); },

  save() {
    const id = document.getElementById('f_id').value;
    const libelle = document.getElementById('f_libelle').value.trim();
    const montant = parseFloat(document.getElementById('f_montant').value);
    if (!libelle || isNaN(montant)) { CC.toast('Libellé et montant sont obligatoires.', 'err'); return; }

    const recue = document.getElementById('f_recue').checked;
    let dateEnc = document.getElementById('f_dateEncaissement').value;
    if (recue && !dateEnc) dateEnc = CC.util.toISO(new Date());
    if (!recue) dateEnc = '';

    let annee = parseInt(document.getElementById('f_annee').value, 10);
    let trim = parseInt(document.getElementById('f_trimestre').value, 10);
    if (dateEnc) { annee = CC.util.yearOf(dateEnc); trim = CC.util.trimestreOfDate(dateEnc); }
    if (!annee) annee = new Date().getFullYear();
    if (!trim) trim = 1;

    const data = {
      libelle, montant,
      numFacture: document.getElementById('f_numFacture').value.trim(),
      modePaiement: document.getElementById('f_modePaiement').value,
      categorie: document.getElementById('f_categorie').value,
      dateEncaissement: dateEnc,
      annee, trimestre: trim,
      dateEnvoi: document.getElementById('f_dateEnvoi').value,
      dateEcheance: document.getElementById('f_dateEcheance').value,
      notes: document.getElementById('f_notes').value.trim(),
      fichier: document.getElementById('f_fichier').value
    };

    if (id) {
      const idx = CC.state.factures.findIndex((x) => x.id === id);
      if (idx >= 0) CC.state.factures[idx] = { ...CC.state.factures[idx], ...data };
    } else {
      CC.state.factures.push({ id: CC.util.uid(), ...data });
    }
    CC.facturesView.closeModal();
    CC.markDirty(); CC.refreshYears(); CC.render();
    CC.toast('Facture enregistrée.');
  },

  remove() {
    const id = document.getElementById('f_id').value;
    if (!id) return;
    CC.state.factures = CC.state.factures.filter((x) => x.id !== id);
    CC.facturesView.closeModal();
    CC.markDirty(); CC.refreshYears(); CC.render();
    CC.toast('Facture supprimée.');
  },

  markRecue(id) {
    const f = CC.state.factures.find((x) => x.id === id);
    if (!f) return;
    f.dateEncaissement = CC.util.toISO(new Date());
    f.annee = CC.util.yearOf(f.dateEncaissement);
    f.trimestre = CC.util.trimestreOfDate(f.dateEncaissement);
    CC.markDirty(); CC.refreshYears(); CC.render();
    CC.toast('Facture marquée comme reçue.');
  },

  bind() {
    // Remplir la liste des categories (modale + filtre)
    document.getElementById('f_categorie').innerHTML = CC.CATEGORIES.map((c) => `<option>${c}</option>`).join('');
    document.getElementById('filterCategorie').innerHTML = '<option value="all">Toutes les activités</option>' +
      CC.CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');
    document.getElementById('btnNewFacture').addEventListener('click', () => CC.facturesView.openModal(null));
    document.getElementById('btnCancelModal').addEventListener('click', () => CC.facturesView.closeModal());

    // Piece jointe (lecture PDF)
    document.getElementById('btnImportPj').addEventListener('click', () => document.getElementById('pjInput').click());
    document.getElementById('pjInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      CC.facturesView.importPj(file);
      e.target.value = ''; // permet de re-choisir le meme fichier
    });
    document.getElementById('btnRemovePj').addEventListener('click', () => CC.facturesView.setPj(''));
    document.getElementById('btnOpenPj').addEventListener('click', () => CC.openPj(document.getElementById('f_fichier').value));
    document.getElementById('btnDeleteFacture').addEventListener('click', () => CC.facturesView.remove());
    document.getElementById('formFacture').addEventListener('submit', (e) => { e.preventDefault(); CC.facturesView.save(); });
    document.getElementById('modalFacture').addEventListener('click', (e) => { if (e.target.id === 'modalFacture') CC.facturesView.closeModal(); });

    // Cocher "reçu" pré-remplit la date du jour ; la date ajuste la période
    document.getElementById('f_recue').addEventListener('change', (e) => {
      const d = document.getElementById('f_dateEncaissement');
      if (e.target.checked && !d.value) d.value = CC.util.toISO(new Date());
      if (!e.target.checked) d.value = '';
      syncPeriode();
    });
    document.getElementById('f_dateEncaissement').addEventListener('change', () => {
      document.getElementById('f_recue').checked = !!document.getElementById('f_dateEncaissement').value;
      syncPeriode();
    });

    document.getElementById('searchInput').addEventListener('input', (e) => { CC.state.filters.search = e.target.value; CC.facturesView.render(); });
    document.getElementById('filterStatus').addEventListener('change', (e) => { CC.state.filters.status = e.target.value; CC.facturesView.render(); });
    document.getElementById('filterTrimestre').addEventListener('change', (e) => { CC.state.filters.trimestre = e.target.value; CC.facturesView.render(); });
    document.getElementById('filterCategorie').addEventListener('change', (e) => { CC.state.filters.categorie = e.target.value; CC.facturesView.render(); });
    document.getElementById('filterPj').addEventListener('change', (e) => { CC.state.filters.pj = e.target.value; CC.facturesView.render(); });

    document.querySelectorAll('#facturesTable th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort, s = CC.state.sort;
        s.dir = (s.key === key && s.dir === 'asc') ? 'desc' : 'asc';
        s.key = key; CC.facturesView.render();
      });
    });

    document.getElementById('facturesBody').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'edit') { const f = CC.state.factures.find((x) => x.id === btn.dataset.id); if (f) CC.facturesView.openModal(f); }
      else if (btn.dataset.act === 'recue') CC.facturesView.markRecue(btn.dataset.id);
      else if (btn.dataset.act === 'pj') { const f = CC.state.factures.find((x) => x.id === btn.dataset.id); if (f) CC.openPj(f.fichier); }
      else if (btn.dataset.act === 'emise') {
        const f = CC.state.factures.find((x) => x.id === btn.dataset.id);
        if (f) { CC.facturesView.openModal(f); document.getElementById('f_numFacture').focus(); }
      }
    });
  }
};

function syncPeriode() {
  const d = document.getElementById('f_dateEncaissement').value;
  if (!d) return;
  document.getElementById('f_annee').value = CC.util.yearOf(d);
  document.getElementById('f_trimestre').value = CC.util.trimestreOfDate(d);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function dotColor(st) { return st === 'recue' ? '#0ea371' : st === 'retard' ? '#dc2626' : st === 'prevu' ? '#6366f1' : '#c2740a'; }
// Icône trombone (SVG, hérite la couleur du texte)
const ICON_CLIP = '<svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
