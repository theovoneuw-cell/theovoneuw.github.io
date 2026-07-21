'use strict';
window.CC = window.CC || {};

CC.importer = {
  findCol(header, keywords) {
    for (let i = 0; i < header.length; i++) {
      const v = String(header[i] || '').toLowerCase();
      if (keywords.some((k) => v.includes(k))) return i;
    }
    return -1;
  },

  cellToISO(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) {
      return CC.util.toISO(new Date(v.getTime() + v.getTimezoneOffset() * 60000));
    }
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return CC.util.toISO(new Date(d.getTime() + d.getTimezoneOffset() * 60000));
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) { let [, dd, mm, yy] = m; if (yy.length === 2) yy = '20' + yy; return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`; }
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return null;
  },

  cellToNum(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/[^\d,.\-]/g, '').replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  },

  parseSheetPeriod(name) {
    const m = name.match(/^T([1-4])_?.*?(\d{4})/i);
    if (m) return { trimestre: +m[1], annee: +m[2] };
    const y = (name.match(/(\d{4})/) || [])[1];
    return { trimestre: null, annee: y ? +y : null };
  },

  parseWorkbook(wb) {
    const factures = [];
    const trimSheets = wb.SheetNames.filter((n) => /^T[1-4]/i.test(n));
    const target = trimSheets.length ? trimSheets : wb.SheetNames.filter((n) => !/total|graph/i.test(n));

    target.forEach((name) => {
      const ws = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      if (!rows.length) return;

      // entete = ligne avec "date" et "montant"
      let hIdx = -1, totalIdx = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].map((x) => String(x).toLowerCase());
        if (hIdx === -1 && r.some((c) => c.includes('date')) && r.some((c) => c.includes('montant'))) hIdx = i;
        if (r.some((c) => c.includes('total brut') || c.includes('ursaff') || c.includes('urssaf'))) { totalIdx = Math.min(totalIdx, i); }
      }
      if (hIdx === -1) return;
      const header = rows[hIdx];
      const cDate = CC.importer.findCol(header, ['date']);
      const cMode = CC.importer.findCol(header, ['paiement', 'mode']);
      const cNum = CC.importer.findCol(header, ['facture', 'n°', 'numero', 'numéro']);
      const cLib = CC.importer.findCol(header, ['libell', 'client', 'nature', 'designation', 'désignation']);
      const cMont = CC.importer.findCol(header, ['montant', 'somme', 'prix']);

      const period = CC.importer.parseSheetPeriod(name);

      for (let i = hIdx + 1; i < totalIdx; i++) {
        const r = rows[i];
        const montant = CC.importer.cellToNum(cMont >= 0 ? r[cMont] : null);
        const libelle = cLib >= 0 ? String(r[cLib] || '').trim() : '';
        if (montant <= 0) continue;                       // ligne vide / sans montant -> ignoree
        if (/total|moyenne|ursaff|urssaf/i.test(libelle)) continue;

        const dateEnc = CC.importer.cellToISO(cDate >= 0 ? r[cDate] : null); // null si non paye

        factures.push({
          id: CC.util.uid(),
          libelle: libelle || '(sans libellé)',
          montant,
          modePaiement: cMode >= 0 ? (String(r[cMode] || '').trim()) : '',
          numFacture: cNum >= 0 ? String(r[cNum] || '').trim() : '',
          dateEncaissement: dateEnc || '',               // "" => non paye
          annee: period.annee,
          trimestre: period.trimestre,
          categorie: CC.util.categoryOf(libelle),
          dateEnvoi: '',
          dateEcheance: '',
          notes: ''
        });
      }
    });
    return factures;
  },

  fromBase64(base64) {
    const wb = XLSX.read(base64, { type: 'base64', cellDates: true });
    return CC.importer.parseWorkbook(wb);
  }
};
