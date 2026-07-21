'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Lecture d'une facture PDF (Indy) — 100% local, via pdf.js embarque.
// Extrait : numero, montant TTC, date d'emission, libelle/objet, echeance.
// ---------------------------------------------------------------------------
CC.pdfImporter = {
  _ready: false,
  _ensure() {
    if (this._ready) return;
    if (typeof pdfjsLib === 'undefined') throw new Error('Module PDF non chargé');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.min.js';
    this._ready = true;
  },

  // Reconstruit les lignes du PDF avec leurs positions (x) pour separer les colonnes.
  async extractRows(arrayBuffer) {
    this._ensure();
    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const rows = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const byY = {};
      for (const it of tc.items) {
        const y = Math.round(it.transform[5]);
        (byY[y] = byY[y] || []).push({ x: it.transform[4], s: it.str });
      }
      Object.keys(byY).map(Number).sort((a, b) => b - a).forEach((y) => {
        const items = byY[y].sort((a, b) => a.x - b.x);
        rows.push({
          full: items.map((i) => i.s).join('').replace(/\s+/g, ' ').trim(),
          desc: items.filter((i) => i.x > 130).map((i) => i.s).join('').replace(/\s+/g, ' ').trim()
        });
      });
    }
    return rows;
  },

  cleanLibelle(s) {
    if (!s) return '';
    return s.replace(/^facture\s+/i, '')        // titre "Facture Cours..." -> "Cours..."
      .replace(/^[\s\-–—:]+/, '')
      .replace(/[\s\-–—:."]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  },

  // Analyse les lignes extraites et renvoie les champs d'une facture.
  parse(rows) {
    const text = rows.map((r) => r.full).join('\n');
    const nospace = text.replace(/\s+/g, '');
    const out = { isIndy: false };

    let m = text.match(/Facture\s+([0-9][0-9 \-]{3,}[0-9])/);
    if (m) {
      const full = m[1].replace(/\s+/g, '');
      out.numFull = full;
      out.num = full.includes('-') ? full.split('-').pop() : full;
    }

    m = nospace.match(/TotalTTC([\d.,]+)€/i) || nospace.match(/TTC([\d.,]+)€/i);
    if (m) {
      let s = m[1];
      s = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
      const n = parseFloat(s);
      if (!isNaN(n)) out.montant = n;
    }

    m = nospace.match(/Émisele(\d{2})\/(\d{2})\/(\d{4})/) || text.match(/Émise le\s*(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) out.dateEnvoi = `${m[3]}-${m[2]}-${m[1]}`;

    const le = rows.find((r) => /Émise le/.test(r.full));
    if (le) out.libelle = this.cleanLibelle(le.desc.split(/Émise le/)[0]);

    m = text.match(/(\d{1,3})\s*jours/);
    out.echeanceJours = m ? parseInt(m[1], 10) : 30;

    out.isIndy = !!(out.numFull && out.montant != null);
    return out;
  },

  async fromArrayBuffer(arrayBuffer) {
    const rows = await this.extractRows(arrayBuffer);
    return this.parse(rows);
  }
};
