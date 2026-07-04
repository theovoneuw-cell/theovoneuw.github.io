'use strict';
window.CC = window.CC || {};
CC._charts = {};

const COL = {
  green: '#0ea371', amber: '#c2740a', red: '#dc2626', blue: '#6366f1',
  brand: '#4f46e5', coral: '#fb7185',
  ink: '#1b1733', grayBar: '#ddd9ec',
  grid: 'rgba(27,23,51,.06)', text: '#6c6890'
};
// Palette catégories : cohérente avec l'identité Indigo & Corail
const CAT_COLORS = ['#4f46e5', '#fb7185', '#0ea371', '#f59e0b', '#8b5cf6', '#14b8a6', '#6366f1'];

Chart.defaults.color = COL.text;
Chart.defaults.font.family = 'Inter, Segoe UI, system-ui, sans-serif';
Chart.defaults.font.size = 11.5;

function makeChart(id, config) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  if (CC._charts[id]) CC._charts[id].destroy();
  CC._charts[id] = new Chart(ctx, config);
}
const baseScales = {
  x: { grid: { display: false }, ticks: { color: COL.text } },
  y: { grid: { color: COL.grid }, border: { display: false }, ticks: { color: COL.text }, beginAtZero: true }
};
function eurTip() { return (c) => `${c.dataset.label || ''}: ${CC.util.eur0(c.parsed.y ?? c.parsed)}`; }

// ---------------------------------------------------------------------------
CC.renderDashboard = function () {
  const S = CC.state, settings = S.settings, year = S.selectedYear, all = S.factures;
  const fy = CC.stats.forYear(all, year);
  const sums = CC.stats.sums(fy, settings);

  // Cotisations (annee ou cumul si "toutes")
  let cot;
  if (year === 'all') {
    let urssaf = 0, encaisse = 0;
    CC.stats.years(all).forEach((y) => { const c = CC.stats.cotisationsYear(CC.stats.forYear(all, y), y, settings); urssaf += c.urssaf; encaisse += c.encaisse; });
    const impot = settings.versementActif ? encaisse * (settings.tauxImpot || 0) / 100 : 0;
    cot = { urssaf, encaisse, impot, net: encaisse - urssaf - impot, trims: null };
  } else {
    cot = CC.stats.cotisationsYear(fy, year, settings);
  }

  // ---------- KPIs ----------
  const recues = fy.filter(CC.stats.isPaid).length;
  const impayes = fy.filter((f) => !CC.stats.isPaid(f) && CC.stats.isInvoiced(f)).length;
  const prevus = fy.filter((f) => !CC.stats.isPaid(f) && !CC.stats.isInvoiced(f)).length;
  const yoy = (year !== 'all') ? CC.stats.yoyRealtime(all, year) : null;
  const yoyTxt = (!yoy || yoy.pct == null) ? '—' : (yoy.pct >= 0 ? '+' : '') + CC.util.pct(yoy.pct);
  const yoyCls = (!yoy || yoy.pct == null) ? '' : (yoy.pct >= 0 ? 'pos' : 'neg');

  const kpis = [
    { cls: 'green', label: 'CA encaissé', value: CC.util.eur0(cot.encaisse), hint: `${recues} facture(s) reçue(s)` },
    { cls: 'amber', label: 'En attente', value: CC.util.eur0(sums.aVenir), hint: `${impayes} émise(s)${prevus ? ' · ' + prevus + ' prévue(s)' : ''}` },
    { cls: 'red', label: 'URSSAF ' + (year === 'all' ? 'cumul' : year), value: CC.util.eur0(cot.urssaf), hint: 'à régler par trimestre' },
    { cls: '', label: 'Net perçu', value: CC.util.eur0(cot.net), hint: settings.versementActif ? 'après URSSAF + impôt' : 'après URSSAF' },
    { cls: '', label: 'Croissance (temps réel)', value: yoyTxt, valueCls: yoyCls, hint: (year === 'all' ? 'choisir une année' : `vs ${year - 1} à la même date`) }
  ];
  document.getElementById('kpiGrid').innerHTML = kpis.map((k) => `
    <div class="kpi ${k.cls}">
      <div class="label">${k.label}</div>
      <div class="value ${k.valueCls || ''}">${k.value}</div>
      <div class="hint">${k.hint}</div>
    </div>`).join('');

  // ---------- URSSAF par trimestre ----------
  renderUrssafQuarters(year, fy, cot);

  // ---------- Encaisse par mois ----------
  if (year !== 'all') {
    const enc = CC.stats.monthlyEncaisse(all, year);
    makeChart('chartMonthly', {
      type: 'bar',
      data: { labels: CC.MOIS, datasets: [{ label: 'Encaissé', data: enc, backgroundColor: COL.green, borderRadius: 4, maxBarThickness: 26 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: baseScales, plugins: { legend: { display: false }, tooltip: { callbacks: { label: eurTip() } } } }
    });
  } else {
    const years = CC.stats.years(all);
    makeChart('chartMonthly', {
      type: 'bar',
      data: { labels: years, datasets: [{ label: 'Encaissé', data: years.map((y) => CC.stats.encaisseYear(all, y)), backgroundColor: COL.green, borderRadius: 4, maxBarThickness: 60 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: baseScales, plugins: { legend: { display: false }, tooltip: { callbacks: { label: eurTip() } } } }
    });
  }

  // ---------- Doughnut ----------
  makeChart('chartStatus', {
    type: 'doughnut',
    data: { labels: ['Encaissé', 'En attente', 'En retard', 'Prévisionnel'], datasets: [{ data: [sums.encaisse, sums.attente, sums.retard, sums.prevu], backgroundColor: [COL.green, COL.amber, COL.red, COL.blue], borderWidth: 2, borderColor: '#fff' }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '64%', plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => `${c.label}: ${CC.util.eur0(c.parsed)}` } } } }
  });

  // ---------- Comparaison annuelle ----------
  const years = CC.stats.years(all);
  makeChart('chartYears', {
    type: 'bar',
    data: { labels: years, datasets: [{ label: 'Encaissé', data: years.map((y) => CC.stats.encaisseYear(all, y)), backgroundColor: years.map((y) => (y === year ? COL.ink : COL.grayBar)), borderRadius: 4, maxBarThickness: 70 }] },
    options: { responsive: true, maintainAspectRatio: false, scales: baseScales, plugins: { legend: { display: false }, tooltip: { callbacks: { label: eurTip() } } } }
  });

  // ---------- Top clients ----------
  const top = CC.stats.topClients(fy, 8);
  // Part de chaque client dans le CA total facturé de la période (tous clients, pas seulement le top 8).
  const caClientsTotal = fy.reduce((a, f) => a + (+f.montant || 0), 0);
  top.forEach((c) => { c.pct = caClientsTotal ? (c.total / caClientsTotal) * 100 : 0; });
  // Plugin inline : écrit le % au bout de chaque barre.
  const pctAuBout = {
    id: 'pctAuBout',
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = '600 11px Inter, Segoe UI, system-ui, sans-serif';
      ctx.fillStyle = COL.text;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      meta.data.forEach((bar, i) => {
        const c = top[i];
        if (!c) return;
        ctx.fillText(CC.util.pct(c.pct, c.pct < 10 ? 1 : 0), bar.x + 6, bar.y);
      });
      ctx.restore();
    }
  };
  makeChart('chartClients', {
    type: 'bar',
    data: { labels: top.map((c) => c.client), datasets: [{ label: 'CA', data: top.map((c) => c.total), backgroundColor: COL.blue, borderRadius: 4, maxBarThickness: 18 }] },
    plugins: [pctAuBout],
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 52 } },   // place pour le % au bout des barres
      scales: { x: { grid: { color: COL.grid }, border: { display: false }, ticks: { color: COL.text }, beginAtZero: true }, y: { grid: { display: false }, ticks: { color: COL.text } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${CC.util.eur0(c.parsed.x)} — ${CC.util.pct(top[c.dataIndex].pct, 1)} du CA — ${top[c.dataIndex].count} facture(s)` } } }
    }
  });

  // ---------- Saisonnalite ----------
  makeChart('chartSeason', {
    type: 'line',
    data: { labels: CC.MOIS, datasets: [{ label: 'Encaissé moyen', data: CC.stats.seasonality(all), borderColor: COL.brand, backgroundColor: 'rgba(79,70,229,.12)', fill: true, tension: 0.35, pointRadius: 2.5, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, scales: baseScales, plugins: { legend: { display: false }, tooltip: { callbacks: { label: eurTip() } } } }
  });

  // ---------- CA par activite ----------
  const cats = CC.stats.caByCategory(fy, false);
  makeChart('chartCategories', {
    type: 'doughnut',
    data: { labels: cats.map((c) => c.categorie), datasets: [{ data: cats.map((c) => c.total), backgroundColor: cats.map((_, i) => CAT_COLORS[i % CAT_COLORS.length]), borderWidth: 2, borderColor: '#fff' }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '58%', plugins: { legend: { position: 'right' }, tooltip: { callbacks: { label: (c) => `${c.label}: ${CC.util.eur0(c.parsed)}` } } } }
  });

  CC.renderForecast(year);
  CC.renderBonus(fy, year);
};

// ---------------------------------------------------------------------------
const MOIS_LONG = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function renderUrssafQuarters(year, fy, cot) {
  const box = document.getElementById('urssafQuarters');
  const sched = document.getElementById('urssafSchedule');
  if (year === 'all' || !cot.trims) {
    box.innerHTML = `<div class="qcell total" style="grid-column:1/-1"><div class="qt">URSSAF — cumul toutes années</div><div class="qv">${CC.util.eur0(cot.urssaf)}</div><div class="qd">Sélectionnez une année pour le détail par trimestre</div></div>`;
    if (sched) renderUrssafSchedule();
    return;
  }
  const cells = cot.trims.map((t) => {
    const due = CC.stats.urssafDueDate(year, t.trimestre);
    return `
    <div class="qcell">
      <div class="qt">T${t.trimestre} · ${CC.util.pct(t.taux)}</div>
      <div class="qv">${CC.util.eur0(t.urssaf)}</div>
      <div class="qd">sur ${CC.util.eur0(t.encaisse)} encaissé</div>
      <div class="qd">prélevé ~ ${MOIS_LONG[due.mois]} ${due.annee}</div>
    </div>`;
  }).join('');
  box.innerHTML = cells + `
    <div class="qcell total">
      <div class="qt">Total ${year}</div>
      <div class="qv">${CC.util.eur0(cot.urssaf)}</div>
      <div class="qd">net après cotisations : ${CC.util.eur0(cot.net)}</div>
    </div>`;
  if (sched) renderUrssafSchedule();
}

// Echeancier : derniere echeance passee + prochaines a venir
function renderUrssafSchedule() {
  const box = document.getElementById('urssafSchedule');
  if (!box) return;
  const all = CC.stats.urssafSchedule(CC.state.factures, CC.state.settings)
    .filter((e) => e.urssaf > 0 || e.statut === 'a-venir');
  const past = all.filter((e) => e.statut === 'preleve');
  const future = all.filter((e) => e.statut === 'a-venir' && e.urssaf > 0);
  const list = past.slice(-1).concat(future.slice(0, 4));
  if (!list.length) { box.innerHTML = ''; return; }

  const rows = list.map((e) => {
    const tag = e.statut === 'a-venir' ? '<span class="sd-tag">à venir</span>' : '<span class="sd-tag past">prélevé</span>';
    return `<div class="sd-row ${e.statut}">
      <span class="sd-date">${MOIS_LONG[e.due.mois]} ${e.due.annee}</span>
      <span class="sd-src">T${e.trimestre} ${e.annee} · sur ${CC.util.eur0(e.encaisse)}</span>
      <span class="sd-amt">${CC.util.eur0(e.urssaf)}</span>
      ${tag}
    </div>`;
  }).join('');
  box.innerHTML = `<div class="sd-title">Échéancier des prélèvements</div>${rows}`;
}

// ---------------------------------------------------------------------------
CC.renderForecast = function (year) {
  const box = document.getElementById('forecastBox');
  if (year === 'all') { box.innerHTML = '<p class="muted">Sélectionnez une année précise pour voir le prévisionnel.</p>'; return; }
  const fc = CC.stats.forecast(CC.state.factures, year, CC.state.settings);
  const cards = [];
  cards.push({ t: 'Encaissé à ce jour', v: CC.util.eur0(fc.encaisse), d: fc.isCurrent ? `jour ${fc.dayOfYear} / ${fc.totalDays}` : 'année complète' });
  cards.push({ t: 'En attente', v: CC.util.eur0(fc.aVenir), d: 'factures non encore payées' });
  if (fc.isCurrent) {
    cards.push({ t: 'Projection fin d\'année', v: CC.util.eur0(fc.projete), d: 'au rythme actuel + en attente' });
    cards.push({ t: 'URSSAF projetée', v: CC.util.eur0(fc.urssafProj), d: 'sur la projection' });
    cards.push({ t: 'Net projeté', v: CC.util.eur0(fc.netProj), d: 'après cotisations' });
  }
  if (fc.histAvg != null) {
    const ref = fc.isCurrent ? fc.projete : fc.encaisse;
    const diff = ref - fc.histAvg;
    cards.push({ t: 'vs moyenne passée', v: (diff >= 0 ? '+' : '') + CC.util.eur0(diff), d: `moyenne : ${CC.util.eur0(fc.histAvg)}` });
  }
  box.innerHTML = cards.map((c) => `<div class="fc"><div class="t">${c.t}</div><div class="v">${c.v}</div><div class="d">${c.d}</div></div>`).join('');
};

// ---------------------------------------------------------------------------
CC.renderBonus = function (fy, year) {
  const S = CC.state, settings = S.settings;
  const avgInv = CC.stats.avgInvoice(fy);
  const top = CC.stats.topClients(fy, 1)[0];

  let bestMonth = '—', bestVal = 0;
  if (year !== 'all') {
    const m = CC.stats.monthlyEncaisse(S.factures, year);
    const idx = m.indexOf(Math.max(...m));
    if (m[idx] > 0) { bestMonth = CC.MOIS[idx]; bestVal = m[idx]; }
  }
  let recordVal = 0, recordLib = '';
  fy.forEach((f) => { if ((+f.montant || 0) > recordVal) { recordVal = +f.montant; recordLib = CC.util.clientKey(f.libelle); } });

  const impayes = fy.filter((f) => !CC.stats.isPaid(f));
  const totalImp = impayes.reduce((a, f) => a + (+f.montant || 0), 0);

  const rows = [];
  rows.push(['Nombre de factures', fy.length]);
  rows.push(['Facture moyenne', CC.util.eur0(avgInv)]);
  if (top) rows.push(['Meilleur client', `${top.client} (${CC.util.eur0(top.total)})`]);
  if (year !== 'all') rows.push(['Meilleur mois', bestMonth === '—' ? '—' : `${bestMonth} (${CC.util.eur0(bestVal)})`]);
  rows.push(['Plus grosse facture', recordVal ? `${CC.util.eur0(recordVal)} — ${recordLib}` : '—']);
  rows.push(['Impayés en cours', impayes.length ? `${impayes.length} (${CC.util.eur0(totalImp)})` : 'aucun']);

  const encaisse = CC.stats.sums(fy, settings).encaisse;
  let gauges = '';
  if (settings.plafond > 0 && year !== 'all') {
    const ratio = Math.min(100, (encaisse / settings.plafond) * 100);
    const cls = ratio > 90 ? 'danger' : ratio > 70 ? 'warn' : '';
    gauges += `<div class="gauge"><div class="lbl"><span>Plafond micro</span><span>${CC.util.pct(ratio, 0)}</span></div><div class="bar"><div class="fill ${cls}" style="width:${ratio}%"></div></div><div class="lbl"><span>${CC.util.eur0(encaisse)}</span><span>${CC.util.eur0(settings.plafond)}</span></div></div>`;
  }
  if (settings.objectif > 0 && year !== 'all') {
    const ratio = Math.min(100, (encaisse / settings.objectif) * 100);
    gauges += `<div class="gauge"><div class="lbl"><span>Objectif annuel</span><span>${CC.util.pct(ratio, 0)}</span></div><div class="bar"><div class="fill" style="width:${ratio}%"></div></div><div class="lbl"><span>${CC.util.eur0(encaisse)}</span><span>${CC.util.eur0(settings.objectif)}</span></div></div>`;
  }

  document.getElementById('bonusBox').innerHTML = rows.map((r) => `<div class="row"><span class="k">${r[0]}</span><span class="v">${r[1]}</span></div>`).join('') + gauges;
};
