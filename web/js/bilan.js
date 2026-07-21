'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Bilan annuel — synthèse complète d'une année écoulée (micro-BNC).
// NB : la micro-entreprise n'établit pas de bilan comptable légal (actif/passif).
// Il s'agit ici d'une synthèse de gestion : CA encaissé, charges, résultat.
// ---------------------------------------------------------------------------
const BILAN_MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

CC.bilan = { _year: null };

CC.renderBilan = function () {
  const S = CC.state, settings = S.settings;
  const body = document.getElementById('bilanBody');
  const sel = document.getElementById('bilanYear');
  if (!body || !sel) return;

  const years = CC.stats.years(S.factures);
  if (!years.length) {
    sel.innerHTML = '';
    body.innerHTML = '<div class="empty">Aucune donnée à analyser pour le moment.</div>';
    return;
  }
  const curY = new Date().getFullYear();

  // Année par défaut : la dernière année TERMINÉE (sinon la plus récente)
  if (CC.bilan._year == null || !years.includes(CC.bilan._year)) {
    const done = years.filter((y) => y < curY);
    CC.bilan._year = done.length ? Math.max(...done) : Math.max(...years);
  }
  const year = CC.bilan._year;
  const enCours = year >= curY;

  // Sélecteur d'année (toutes les années disponibles)
  sel.innerHTML = years.slice().sort((a, b) => b - a)
    .map((y) => `<option value="${y}"${y === year ? ' selected' : ''}>${y}${y >= curY ? ' (en cours)' : ''}</option>`).join('');

  // ----- Calculs -----
  const fy = CC.stats.forYear(S.factures, year);
  const paid = fy.filter((f) => CC.stats.isPaid(f));
  const cot = CC.stats.cotisationsYear(fy, year, settings);   // { urssaf, impot, encaisse, net, trims }
  const enc = cot.encaisse;
  const urssaf = cot.urssaf;
  const tauxMoyen = cot.trims.reduce((a, t) => a + t.taux, 0) / 4;

  const ab = settings.abattementBNC || 34;
  const baseImp = enc * (1 - ab / 100);
  let impot = 0, impotLbl = '—', impotHint = 'renseigne ta tranche (Paramètres)';
  if (settings.versementActif) { impot = enc * (settings.tauxImpot || 0) / 100; impotLbl = CC.util.eur0(impot); impotHint = `versement libératoire ${CC.util.pct(settings.tauxImpot)}`; }
  else if (settings.tmi > 0) { impot = baseImp * settings.tmi / 100; impotLbl = '≈ ' + CC.util.eur0(impot); impotHint = `tranche ${CC.util.pct(settings.tmi, 0)} sur base imposable`; }
  const net = enc - urssaf - impot;

  const prevEnc = CC.stats.encaisseYear(S.factures, year - 1);
  const yoyPct = prevEnc ? ((enc - prevEnc) / prevEnc) * 100 : null;

  const mens = CC.stats.monthlyEncaisse(S.factures, year);
  let bestIdx = -1, bestVal = -1;
  mens.forEach((v, i) => { if (v > bestVal) { bestVal = v; bestIdx = i; } });
  const nbFac = paid.length;
  const panier = nbFac ? enc / nbFac : 0;

  const cats = CC.stats.caByCategory(fy, true);
  const top = CC.stats.topClients(fy, 6);

  // ----- KPIs de synthèse -----
  const yoyTxt = yoyPct == null ? '' : `${yoyPct >= 0 ? '+' : ''}${CC.util.pct(yoyPct, 1)} vs ${year - 1}`;
  const kpis = [
    { cls: 'green', label: 'Chiffre d\'affaires encaissé', value: CC.util.eur0(enc), hint: yoyTxt || `${nbFac} facture(s)` },
    { cls: 'amber', label: 'Cotisations URSSAF', value: CC.util.eur0(urssaf), hint: `taux moyen ${CC.util.pct(tauxMoyen, 1)}` },
    { cls: 'blue', label: 'Impôt sur le revenu', value: impotLbl, hint: impotHint },
    { cls: 'green', label: 'Résultat net estimé', value: CC.util.eur0(net), hint: 'après URSSAF & impôt' }
  ];

  // ----- CA : par trimestre -----
  const trimRows = cot.trims.map((t) => {
    const part = enc ? (t.encaisse / enc) * 100 : 0;
    return `<tr>
      <td class="q">T${t.trimestre}</td>
      <td class="num">${CC.util.eur0(t.encaisse)}</td>
      <td class="num">${CC.util.eur0(t.urssaf)}</td>
      <td class="num">${CC.util.pct(part, 0)}</td>
    </tr>`;
  }).join('');

  // ----- Répartition par activité (barres) -----
  const catTotal = cats.reduce((a, c) => a + c.total, 0) || 1;
  const catHtml = cats.length ? cats.map((c) => {
    const part = (c.total / catTotal) * 100;
    return `<div class="bilan-cat">
      <div class="bilan-cat-top"><span>${esc(c.categorie)}</span><span class="num-tab">${CC.util.eur0(c.total)} · ${CC.util.pct(part, 0)}</span></div>
      <div class="bilan-cat-bar"><div class="bilan-cat-fill" style="width:${part.toFixed(1)}%"></div></div>
    </div>`;
  }).join('') : '<div class="ck-empty">Aucune activité catégorisée.</div>';

  // ----- Top clients -----
  const topHtml = top.length ? `<table class="fiscal-table"><thead><tr><th>Client</th><th class="num">CA encaissé</th><th class="num">Factures</th></tr></thead><tbody>` +
    top.map((c) => `<tr><td class="q">${esc(c.client)}</td><td class="num">${CC.util.eur0(c.paye)}</td><td class="num">${c.count}</td></tr>`).join('') +
    `</tbody></table>` : '<div class="ck-empty">Aucun client.</div>';

  // ----- Seuils (où l'année a atterri) -----
  const plafond = CC.effPlafond(year);
  const baseTva = settings.seuilTvaBase;
  const seuilsHtml = gauge('Franchise TVA (base ' + CC.util.eur0(baseTva) + ')', enc, baseTva) +
    gauge('Plafond micro ' + year, enc, plafond);

  // ----- Assemblage -----
  body.innerHTML = `
    <div class="bilan-title">
      <h2>Bilan ${year}${enCours ? ' <span class="bilan-tag">année en cours</span>' : ''}</h2>
      <p class="card-sub">${enCours
        ? 'Année non terminée : chiffres provisoires, arrêtés à aujourd\'hui.'
        : 'Synthèse de l\'année écoulée, sur l\'argent réellement encaissé.'}</p>
    </div>

    <div class="kpi-grid">
      ${kpis.map((k) => `<div class="kpi ${k.cls}"><div class="label">${k.label}</div><div class="value">${k.value}</div><div class="hint">${k.hint}</div></div>`).join('')}
    </div>

    <div class="card-grid">
      <div class="card">
        <h3>Chiffre d'affaires</h3>
        <p class="card-sub">Détail par trimestre et indicateurs clés de l'année.</p>
        <div class="forecast" style="margin-bottom:14px">
          <div class="fc"><div class="t">CA encaissé</div><div class="v">${CC.util.eur0(enc)}</div><div class="d">${nbFac} facture(s)</div></div>
          <div class="fc"><div class="t">Croissance</div><div class="v">${yoyPct == null ? '—' : (yoyPct >= 0 ? '+' : '') + CC.util.pct(yoyPct, 1)}</div><div class="d">${prevEnc ? 'vs ' + (year - 1) + ' (' + CC.util.eur0(prevEnc) + ')' : 'pas d\'année N-1'}</div></div>
          <div class="fc"><div class="t">Meilleur mois</div><div class="v">${bestVal > 0 ? cap(BILAN_MOIS[bestIdx]) : '—'}</div><div class="d">${bestVal > 0 ? CC.util.eur0(bestVal) : ''}</div></div>
          <div class="fc"><div class="t">Panier moyen</div><div class="v">${CC.util.eur0(panier)}</div><div class="d">par facture</div></div>
        </div>
        <table class="fiscal-table">
          <thead><tr><th>Trimestre</th><th class="num">CA encaissé</th><th class="num">URSSAF</th><th class="num">Part</th></tr></thead>
          <tbody>${trimRows}</tbody>
        </table>
      </div>

      <div class="card">
        <h3>Répartition par activité</h3>
        <p class="card-sub">Part de chaque type d'activité dans le CA ${year}.</p>
        ${catHtml}
      </div>
    </div>

    <div class="card-grid">
      <div class="card">
        <h3>Charges sociales &amp; fiscalité</h3>
        <p class="card-sub">Ce que l'année a généré comme cotisations et impôt.</p>
        <table class="fiscal-table">
          <tbody>
            <tr><td class="q">CA encaissé ${year}</td><td class="num">${CC.util.eur0(enc)}</td></tr>
            <tr><td>Cotisations URSSAF (taux moyen ${CC.util.pct(tauxMoyen, 1)})</td><td class="num">− ${CC.util.eur0(urssaf)}</td></tr>
            <tr><td>Abattement forfaitaire ${ab}%</td><td class="num">− ${CC.util.eur0(enc * ab / 100)}</td></tr>
            <tr><td class="q">Base imposable</td><td class="num">${CC.util.eur0(baseImp)}</td></tr>
            <tr><td>Impôt sur le revenu (${impotHint})</td><td class="num">${impot ? '− ' + CC.util.eur0(impot) : '—'}</td></tr>
            <tr><td class="q">Résultat net estimé</td><td class="num"><b>${CC.util.eur0(net)}</b></td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3>Position vs seuils</h3>
        <p class="card-sub">Où le CA ${year} se situe par rapport à la franchise TVA et au plafond micro.</p>
        ${seuilsHtml}
      </div>
    </div>

    <div class="card">
      <h3>Top clients ${year}</h3>
      <p class="card-sub">Les clients qui ont le plus pesé dans le CA encaissé.</p>
      ${topHtml}
    </div>

    <p class="bilan-note">Synthèse de gestion indicative. La micro-entreprise (BNC) est dispensée de bilan comptable légal ; ce récapitulatif ne remplace pas une comptabilité d'engagement ni l'avis d'un expert-comptable.</p>
  `;
};

// Année par défaut du bilan (dernière année terminée, sinon la plus récente).
CC.bilan.resolveYear = function () {
  const years = CC.stats.years(CC.state.factures);
  if (!years.length) return null;
  const curY = new Date().getFullYear();
  if (CC.bilan._year == null || !years.includes(CC.bilan._year)) {
    const done = years.filter((y) => y < curY);
    CC.bilan._year = done.length ? Math.max(...done) : Math.max(...years);
  }
  return CC.bilan._year;
};

// Document HTML autonome, mis en page pour l'impression (export PDF épuré).
// N'utilise PAS les formateurs de l'app (pas de masquage) : on veut les vrais chiffres.
CC.bilan.buildPrintHTML = function (year) {
  const S = CC.state, settings = S.settings;
  const eur0 = (n) => { if (n == null || isNaN(n)) n = 0; return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n); };
  const pct = (n, d = 1) => { if (n == null || isNaN(n)) n = 0; return n.toFixed(d).replace('.', ',') + ' %'; };

  const fy = CC.stats.forYear(S.factures, year);
  const paid = fy.filter((f) => CC.stats.isPaid(f));
  const cot = CC.stats.cotisationsYear(fy, year, settings);
  const enc = cot.encaisse, urssaf = cot.urssaf;
  const tauxMoyen = cot.trims.reduce((a, t) => a + t.taux, 0) / 4;
  const ab = settings.abattementBNC || 34;
  const baseImp = enc * (1 - ab / 100);
  let impot = 0, impotHint = 'non estimé (renseigne ta tranche)';
  if (settings.versementActif) { impot = enc * (settings.tauxImpot || 0) / 100; impotHint = 'versement libératoire ' + pct(settings.tauxImpot); }
  else if (settings.tmi > 0) { impot = baseImp * settings.tmi / 100; impotHint = 'tranche ' + pct(settings.tmi, 0) + ' sur base imposable'; }
  const net = enc - urssaf - impot;
  const prevEnc = CC.stats.encaisseYear(S.factures, year - 1);
  const yoyPct = prevEnc ? ((enc - prevEnc) / prevEnc) * 100 : null;
  const mens = CC.stats.monthlyEncaisse(S.factures, year);
  let bestIdx = -1, bestVal = -1; mens.forEach((v, i) => { if (v > bestVal) { bestVal = v; bestIdx = i; } });
  const nbFac = paid.length, panier = nbFac ? enc / nbFac : 0;
  const cats = CC.stats.caByCategory(fy, true);
  const top = CC.stats.topClients(fy, 8);
  const catTotal = cats.reduce((a, c) => a + c.total, 0) || 1;
  const plafond = CC.effPlafond(year);
  const baseTva = settings.seuilTvaBase;
  const curY = new Date().getFullYear();
  const enCours = year >= curY;
  const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  const trimRows = cot.trims.map((t) => {
    const part = enc ? (t.encaisse / enc) * 100 : 0;
    return `<tr><td>T${t.trimestre}</td><td class="n">${eur0(t.encaisse)}</td><td class="n">${eur0(t.urssaf)}</td><td class="n">${pct(part, 0)}</td></tr>`;
  }).join('');

  const catRows = cats.length ? cats.map((c) => {
    const part = (c.total / catTotal) * 100;
    return `<tr><td>${esc(c.categorie)}</td><td class="n">${eur0(c.total)}</td><td class="n">${pct(part, 0)}</td><td class="barcell"><span class="barwrap"><span class="bar" style="width:${part.toFixed(1)}%"></span></span></td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">Aucune activité catégorisée.</td></tr>';

  const topRows = top.length ? top.map((c) => `<tr><td>${esc(c.client)}</td><td class="n">${eur0(c.paye)}</td><td class="n">${c.count}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">Aucun client.</td></tr>';

  const seuil = (label, val, max) => {
    const r = Math.min(100, (val / max) * 100);
    const cls = r > 95 ? ' danger' : r > 80 ? ' warn' : '';
    return `<div class="seuil"><div class="seuil-top"><span>${label}</span><span>${pct(r, 0)} · ${eur0(val)} / ${eur0(max)}</span></div><div class="barwrap"><span class="bar${cls}" style="width:${r}%"></span></div></div>`;
  };

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Bilan ${year}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #1b1733; margin: 0; font-size: 12px; line-height: 1.5; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #4f46e5; padding-bottom: 12px; margin-bottom: 20px; }
  .head h1 { margin: 0; font-size: 26px; letter-spacing: -.4px; }
  .head .sub { color: #6b7280; margin-top: 4px; }
  .head .who { text-align: right; color: #374151; font-size: 11.5px; }
  .muted { color: #9ca3af; }
  .figs { display: flex; gap: 10px; margin-bottom: 22px; }
  .fig { flex: 1; border: 1px solid #e5e7eb; border-radius: 10px; padding: 11px 13px; }
  .fig .l { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: .5px; }
  .fig .v { font-size: 19px; font-weight: 700; margin-top: 4px; }
  .fig .h { font-size: 10px; color: #9ca3af; margin-top: 3px; }
  section { margin-bottom: 20px; break-inside: avoid; }
  h2 { font-size: 12px; margin: 0 0 9px; color: #4f46e5; text-transform: uppercase; letter-spacing: .6px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #6b7280; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .3px; border-bottom: 1px solid #e5e7eb; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #f1f1f5; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { font-weight: 700; border-top: 2px solid #e5e7eb; border-bottom: none; }
  .barcell { width: 32%; }
  .barwrap { display: inline-block; width: 100%; height: 7px; background: #eef0f6; border-radius: 4px; overflow: hidden; vertical-align: middle; }
  .bar { display: block; height: 100%; background: #4f46e5; }
  .bar.warn { background: #d97706; } .bar.danger { background: #dc2626; }
  .seuil { margin-bottom: 11px; }
  .seuil-top { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px; }
  .stat-line { color: #6b7280; font-size: 11px; margin: 0 0 10px; }
  .foot { margin-top: 24px; font-size: 9.5px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 9px; }
</style></head>
<body>
  <div class="head">
    <div>
      <h1>Bilan ${year}${enCours ? ' <span style="font-size:13px;color:#d97706;font-weight:600">· année en cours</span>' : ''}</h1>
      <div class="sub">${enCours ? 'Chiffres provisoires, arrêtés au ' + today : 'Synthèse de l\'année — sur l\'argent réellement encaissé'}</div>
    </div>
    <div class="who"><b>Théo Von Euw</b><br>Entreprise individuelle<br>Micro-entreprise (BNC)<br><span class="muted">Édité le ${today}</span></div>
  </div>

  <div class="figs">
    <div class="fig" style="border-top:3px solid #16a34a"><div class="l">CA encaissé</div><div class="v">${eur0(enc)}</div><div class="h">${yoyPct == null ? nbFac + ' facture(s)' : (yoyPct >= 0 ? '+' : '') + pct(yoyPct, 1) + ' vs ' + (year - 1)}</div></div>
    <div class="fig" style="border-top:3px solid #d97706"><div class="l">Cotisations URSSAF</div><div class="v">${eur0(urssaf)}</div><div class="h">taux moyen ${pct(tauxMoyen, 1)}</div></div>
    <div class="fig" style="border-top:3px solid #4f46e5"><div class="l">Impôt sur le revenu</div><div class="v">${impot ? eur0(impot) : '—'}</div><div class="h">${impotHint}</div></div>
    <div class="fig" style="border-top:3px solid #16a34a"><div class="l">Résultat net estimé</div><div class="v">${eur0(net)}</div><div class="h">après URSSAF &amp; impôt</div></div>
  </div>

  <section>
    <h2>Chiffre d'affaires par trimestre</h2>
    <p class="stat-line">Meilleur mois : <b>${bestVal > 0 ? cap(BILAN_MOIS[bestIdx]) + ' (' + eur0(bestVal) + ')' : '—'}</b> · Panier moyen : <b>${eur0(panier)}</b> · ${nbFac} facture(s) encaissée(s)</p>
    <table>
      <thead><tr><th>Trimestre</th><th class="n">CA encaissé</th><th class="n">URSSAF</th><th class="n">Part</th></tr></thead>
      <tbody>${trimRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Charges sociales &amp; fiscalité</h2>
    <table><tbody>
      <tr><td>CA encaissé ${year}</td><td class="n">${eur0(enc)}</td></tr>
      <tr><td>Cotisations URSSAF (taux moyen ${pct(tauxMoyen, 1)})</td><td class="n">− ${eur0(urssaf)}</td></tr>
      <tr><td>Abattement forfaitaire ${ab} %</td><td class="n">− ${eur0(enc * ab / 100)}</td></tr>
      <tr><td>Base imposable</td><td class="n">${eur0(baseImp)}</td></tr>
      <tr><td>Impôt sur le revenu (${impotHint})</td><td class="n">${impot ? '− ' + eur0(impot) : '—'}</td></tr>
      <tr class="total"><td>Résultat net estimé</td><td class="n">${eur0(net)}</td></tr>
    </tbody></table>
  </section>

  <section>
    <h2>Répartition par activité</h2>
    <table>
      <thead><tr><th>Activité</th><th class="n">CA</th><th class="n">Part</th><th></th></tr></thead>
      <tbody>${catRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Position vs seuils</h2>
    ${seuil('Franchise TVA (base ' + eur0(baseTva) + ')', enc, baseTva)}
    ${seuil('Plafond micro ' + year, enc, plafond)}
  </section>

  <section>
    <h2>Top clients ${year}</h2>
    <table>
      <thead><tr><th>Client</th><th class="n">CA encaissé</th><th class="n">Factures</th></tr></thead>
      <tbody>${topRows}</tbody>
    </table>
  </section>

  <div class="foot">Synthèse de gestion indicative, générée par Ma Compta. La micro-entreprise (BNC) est dispensée de bilan comptable légal ; ce récapitulatif ne remplace pas une comptabilité d'engagement ni l'avis d'un expert-comptable.</div>
</body></html>`;
};

// Jauge identique à l'onglet Fiscal
function gauge(label, val, max) {
  const ratio = Math.min(100, (val / max) * 100);
  const cls = ratio > 95 ? 'danger' : ratio > 80 ? 'warn' : '';
  return `<div class="gauge"><div class="lbl"><span>${label}</span><span>${CC.util.pct(ratio, 0)}</span></div>
    <div class="bar"><div class="fill ${cls}" style="width:${ratio}%"></div></div>
    <div class="lbl"><span>${CC.util.eur0(val)}</span><span>${CC.util.eur0(max)}</span></div></div>`;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
