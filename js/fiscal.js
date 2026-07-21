'use strict';
window.CC = window.CC || {};

const FMOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function frD(d) { return d.getDate() + ' ' + FMOIS[d.getMonth()] + ' ' + d.getFullYear(); }

CC.renderFiscal = function () {
  const S = CC.state, settings = S.settings;
  const year = (S.selectedYear === 'all') ? new Date().getFullYear() : S.selectedYear;
  const fy = CC.stats.forYear(S.factures, year);
  const today = new Date();

  // ---------- À déclarer maintenant (carte focalisée + bouton Copier) ----------
  (function renderUrssafNow() {
    const box = document.getElementById('urssafNow');
    if (!box) return;
    // Trimestre à déclarer : le plus urgent (échéance dépassée non déclarée),
    // sinon la prochaine échéance non déclarée, sinon la prochaine échéance.
    const cand = [];
    for (let y = today.getFullYear() - 1; y <= today.getFullYear() + 1; y++)
      for (let t = 1; t <= 4; t++) cand.push({ y, t, dl: CC.stats.urssafDeclDeadline(y, t) });
    cand.sort((a, b) => a.dl - b.dl);
    const declared = (c) => (S.declarations[c.y + '-' + c.t] || {}).declare;
    const overdue = cand.filter((c) => c.dl < today && !declared(c));
    const upcoming = cand.filter((c) => c.dl >= today && !declared(c));
    const futur = cand.filter((c) => c.dl >= today);
    const sel = overdue.length ? overdue[overdue.length - 1] : (upcoming[0] || futur[0] || cand[cand.length - 1]);

    const fyy = CC.stats.forYear(S.factures, sel.y);
    const enc = CC.stats.encaisseTrim(fyy, sel.y, sel.t);
    const taux = CC.urssafRate(sel.y, sel.t);
    const urssaf = enc * taux / 100;
    const key = sel.y + '-' + sel.t;
    const dec = S.declarations[key] || {};
    const days = CC.util.daysBetween(today, sel.dl);
    const overdueSel = days < 0;
    let dlTxt, dlCls;
    if (dec.declare) { dlTxt = 'déclaré ✓'; dlCls = 'ok'; }
    else if (overdueSel) { dlTxt = 'échéance dépassée le ' + frD(sel.dl); dlCls = 'danger'; }
    else { dlTxt = 'à déclarer avant le ' + frD(sel.dl) + (days <= 31 ? ' · dans ' + days + ' j' : ''); dlCls = days <= 15 ? 'urgent' : ''; }
    const caR = Math.round(enc);

    box.innerHTML = `
      <h3>À déclarer à l'URSSAF</h3>
      <p class="card-sub">Le montant exact à reporter dans ta déclaration, prêt à copier.</p>
      <div class="un-grid">
        <div class="un-info">
          <div class="un-trim">T${sel.t} ${sel.y} <span class="un-dl ${dlCls}">${dlTxt}</span></div>
          <div class="un-ca">${CC.util.eur0(enc)}</div>
          <div class="un-note">CA encaissé du trimestre · cotisations + contributions URSSAF estimées <b>${CC.util.eur0(urssaf)}</b> (${String(taux).replace('.', ',')} %, CFP/CCI inclus)</div>
        </div>
        <div class="un-actions">
          <button type="button" class="btn btn-primary" id="unCopy">Copier&nbsp;: ${caR.toLocaleString('fr-FR')} €</button>
          <label class="check un-declare"><input type="checkbox" id="unDeclare" ${dec.declare ? 'checked' : ''}> Marquer déclaré</label>
          <button type="button" class="btn-urssaf" id="unOpen" title="Ouvrir le site auto-entrepreneur de l'Urssaf">
            <svg class="urssaf-logo" viewBox="0 22 105 106" width="19" height="19" aria-hidden="true"><path fill="#1ECAD3" d="M0.16,48.81c0,14.5,11.76,26.26,26.26,26.26s26.26-11.76,26.26-26.26S40.92,22.55,26.42,22.55C11.91,22.55,0.16,34.31,0.16,48.81"/><path fill="#90B3E6" d="M52.48,75.07h52.13c0,29.01-23.34,52.52-52.13,52.52C52.48,127.59,52.48,75.07,52.48,75.07z"/><path fill="#0071CE" d="M104.6,22.55v52.52H52.48C52.48,46.06,75.81,22.55,104.6,22.55"/><path fill="#D0DDF4" d="M52.48,75.07H0.35c0,29.01,23.34,52.52,52.13,52.52C52.48,127.59,52.48,75.07,52.48,75.07z"/></svg>
            <span>Déclarer sur <b>urssaf.fr</b></span>
            <svg class="urssaf-ext" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M9 7h8v8"/></svg>
          </button>
        </div>
      </div>`;

    const copyBtn = document.getElementById('unCopy');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(String(caR)); CC.toast('Montant copié : ' + caR.toLocaleString('fr-FR') + ' € — colle-le dans ta déclaration URSSAF.', 'ok'); }
      catch (_) { CC.toast('Copie impossible.', 'err'); }
    });
    const decBox = document.getElementById('unDeclare');
    if (decBox) decBox.addEventListener('change', (e) => {
      S.declarations[key] = S.declarations[key] || {};
      S.declarations[key].declare = e.target.checked;
      CC.markDirty();
      CC.renderFiscal();   // resynchronise la carte ET le tableau ci-dessous
    });
    const openBtn = document.getElementById('unOpen');
    if (openBtn) openBtn.addEventListener('click', () => { try { window.api.openUrl('https://www.autoentrepreneur.urssaf.fr/'); } catch (_) {} });
  })();

  // ---------- Déclarations URSSAF ----------
  const cot = CC.stats.cotisationsYear(fy, year, settings);
  let rows = cot.trims.map((t) => {
    const dl = CC.stats.urssafDeclDeadline(year, t.trimestre);
    const key = `${year}-${t.trimestre}`;
    const dec = S.declarations[key] || {};
    const days = CC.util.daysBetween(today, dl);
    const urgent = !dec.declare && days >= 0 && days <= 30;
    const passe = days < 0;
    const dlTxt = passe ? ('échu — ' + frD(dl)) : (frD(dl) + (urgent ? ` · dans ${days} j` : ''));
    return `<tr>
      <td class="q" data-label="Trimestre">T${t.trimestre} ${year}</td>
      <td class="num" data-label="CA à déclarer">${CC.util.eur0(t.encaisse)}</td>
      <td class="num" data-label="URSSAF">${CC.util.eur0(t.urssaf)}</td>
      <td class="deadline ${urgent ? 'urgent' : ''}" data-label="Date limite">${dlTxt}</td>
      <td class="ctr" data-label="Déclaré"><input type="checkbox" class="chk" data-k="${key}" data-f="declare" ${dec.declare ? 'checked' : ''}></td>
      <td class="ctr" data-label="Payé"><input type="checkbox" class="chk" data-k="${key}" data-f="paye" ${dec.paye ? 'checked' : ''}></td>
    </tr>`;
  }).join('');
  document.getElementById('fiscalDeclarations').innerHTML = `
    <table class="fiscal-table">
      <thead><tr><th>Trimestre</th><th class="num">CA à déclarer</th><th class="num">URSSAF</th><th>Date limite</th><th class="ctr">Déclaré</th><th class="ctr">Payé</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  document.querySelectorAll('#fiscalDeclarations .chk').forEach((c) => {
    c.addEventListener('change', (e) => {
      const k = e.target.dataset.k, f = e.target.dataset.f;
      S.declarations[k] = S.declarations[k] || {};
      S.declarations[k][f] = e.target.checked;
      CC.markDirty();
    });
  });

  // ---------- Seuils ----------
  const enc = cot.encaisse;
  const plafond = CC.effPlafond(year);
  const base = settings.seuilTvaBase, majore = settings.seuilTvaMajore;
  function gauge(label, val, max, extra) {
    const ratio = Math.min(100, (val / max) * 100);
    const cls = ratio > 95 ? 'danger' : ratio > 80 ? 'warn' : '';
    return `<div class="gauge"><div class="lbl"><span>${label}</span><span>${CC.util.pct(ratio, 0)}</span></div>
      <div class="bar"><div class="fill ${cls}" style="width:${ratio}%"></div></div>
      <div class="lbl"><span>${CC.util.eur0(val)}</span><span>${extra || CC.util.eur0(max)}</span></div></div>`;
  }
  document.getElementById('fiscalSeuils').innerHTML =
    `<div class="seuil">${gauge('Franchise TVA (base ' + CC.util.eur0(base) + ')', enc, base)}</div>` +
    `<div class="seuil">${gauge('Plafond micro ' + year, enc, plafond)}</div>`;

  // ---------- Alerte seuil TVA ----------
  const restant = base - enc;
  let alert = '';
  if (enc > majore) {
    alert = `<div class="alert danger"><span class="ai">!</span><div><b>Seuil de TVA majoré dépassé (${CC.util.eur0(majore)}).</b> La TVA devient applicable. Pense à facturer la TVA et à te rapprocher de l'URSSAF / ton comptable.</div></div>`;
  } else if (enc > base) {
    alert = `<div class="alert warn"><span class="ai">!</span><div><b>Seuil de TVA de base dépassé (${CC.util.eur0(base)}).</b> Tu restes en franchise cette année, mais si tu repasses au-dessus l'an prochain (ou dépasses ${CC.util.eur0(majore)}), la TVA s'applique. À surveiller.</div></div>`;
  } else if (restant <= base * 0.1) {
    alert = `<div class="alert warn"><span class="ai">~</span><div><b>Tu approches du seuil de TVA :</b> il te reste <b>${CC.util.eur0(restant)}</b> avant ${CC.util.eur0(base)} pour ${year}.</div></div>`;
  } else {
    alert = `<div class="alert ok"><span class="ai">✓</span><div>Sous le seuil de TVA pour ${year} : ${CC.util.eur0(enc)} encaissé, marge de ${CC.util.eur0(restant)} avant ${CC.util.eur0(base)}.</div></div>`;
  }
  document.getElementById('seuilAlert').innerHTML = alert;

  // ---------- Estimation IR ----------
  const ab = settings.abattementBNC || 34;
  const baseImp = enc * (1 - ab / 100);
  let irBlocks = [
    { t: 'CA encaissé ' + year, v: CC.util.eur0(enc), d: '' },
    { t: `Abattement ${ab}%`, v: '− ' + CC.util.eur0(enc * ab / 100), d: 'forfaitaire micro-BNC' },
    { t: 'Base imposable', v: CC.util.eur0(baseImp), d: 'à ajouter aux revenus du foyer' }
  ];
  if (settings.versementActif) {
    irBlocks.push({ t: 'Impôt (versement libératoire)', v: CC.util.eur0(enc * (settings.tauxImpot || 0) / 100), d: `${CC.util.pct(settings.tauxImpot)} du CA` });
  } else if (settings.tmi > 0) {
    irBlocks.push({ t: 'Impôt estimé', v: '≈ ' + CC.util.eur0(baseImp * settings.tmi / 100), d: `à ta tranche de ${CC.util.pct(settings.tmi, 0)}` });
  } else {
    irBlocks.push({ t: 'Impôt estimé', v: '—', d: 'renseigne ta tranche dans Paramètres' });
  }
  document.getElementById('fiscalIR').innerHTML =
    `<div class="ir-grid">` + irBlocks.map((b) => `<div class="fc"><div class="t">${b.t}</div><div class="v">${b.v}</div><div class="d">${b.d}</div></div>`).join('') + `</div>`;

  // ---------- Calendrier fiscal ----------
  const events = [];
  [year, year + 1].forEach((y) => {
    for (let t = 1; t <= 4; t++) events.push({ date: CC.stats.urssafDeclDeadline(y, t), label: `Déclaration URSSAF T${t} ${y}`, kind: 'URSSAF' });
    events.push({ date: new Date(y, 11, 15), label: `CFE ${y} (cotisation foncière)`, kind: 'CFE' });
    events.push({ date: new Date(y, 4, 25), label: `Déclaration de revenus ${y - 1}`, kind: 'Impôt' });
  });
  const next = events.filter((e) => e.date >= today).sort((a, b) => a.date - b.date).slice(0, 6);
  document.getElementById('fiscalCalendar').innerHTML = next.map((e) => {
    const days = CC.util.daysBetween(today, e.date);
    return `<div class="sd-row"><span class="sd-date">${frD(e.date)}</span><span class="sd-src">${e.label}</span><span class="sd-amt"></span><span class="sd-tag ${days > 30 ? 'past' : ''}">dans ${days} j</span></div>`;
  }).join('');
};
