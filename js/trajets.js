'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Onglet Trajets : frais kilométriques (carte + distance par la route +
// indemnité au barème + péages TollGuru). Journal des trajets enregistrés.
// Seul module de l'app à interroger des services en ligne pour fonctionner.
// ---------------------------------------------------------------------------
CC.trajets = {
  _map: null,
  _route: null,     // polyline du tracé
  _markers: [],
  _from: null,      // { lat, lon, label } sélectionné pour le départ
  _to: null,        // idem arrivée
  _last: null,      // dernier calcul (pour l'enregistrement)
  _acTimer: null,
  _tollCache: {},   // cache des péages par trajet (évite de re-consommer le quota)

  // ---- Rendu de l'onglet ----
  render() {
    CC.trajets.ensureMap();
    CC.trajets.renderRate();
    CC.trajets.renderList();
    // La carte a pu être créée hors écran : recalculer ses dimensions.
    if (CC.trajets._map) setTimeout(() => CC.trajets._map.invalidateSize(), 60);
  },

  ensureMap() {
    if (CC.trajets._map || typeof L === 'undefined') return;
    const el = document.getElementById('tj_map');
    if (!el) return;
    const map = L.map(el, { zoomControl: true, attributionControl: false, zoomSnap: 0.5 }).setView([46.6, 2.5], 5);
    // Fond de carte clair et moderne (CARTO Voyager), rendu net sur écrans Retina.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      subdomains: 'abcd'
    }).addTo(map);
    map.zoomControl.setPosition('topright');
    CC.trajets._map = map;
  },

  renderRate() {
    const s = CC.state.settings;
    // Pré-remplit les champs carburant à partir des paramètres
    const fp = document.getElementById('tj_fuelPrice');
    const fc = document.getElementById('tj_fuelConso');
    if (fp) fp.value = (s.prixCarburant != null ? s.prixCarburant : 1.90);
    if (fc) fc.value = (s.consoL100 != null ? s.consoL100 : 6.5);
    const tolls = document.getElementById('tj_tolls');
    if (tolls) tolls.checked = (s.calcTolls !== false);
    const box = document.getElementById('tj_rateInfo');
    if (!box) return;
    const tarif = (s.tarifKm != null ? s.tarifKm : 0.636);
    const toll = CC._tollReady ? 'péages TollGuru actifs' : 'péages non configurés (Paramètres → Connexions)';
    box.textContent = `Barème : ${tarif.toString().replace('.', ',')} €/km · ${s.chevauxFiscaux || 5} CV · ${toll} · Carte © OSM/CARTO`;
  },

  // ---- Autocomplétion d'adresses ----
  bindAutocomplete(inputId, listId, which) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!input || !list) return;

    input.addEventListener('input', () => {
      CC.trajets['_' + which] = null;           // la sélection n'est plus valide
      CC.trajets._setSaveEnabled(false);
      const q = input.value.trim();
      clearTimeout(CC.trajets._acTimer);
      if (q.length < 3) { list.classList.add('hidden'); list.innerHTML = ''; return; }
      CC.trajets._acTimer = setTimeout(async () => {
        const r = await window.api.routes.geocode(q);
        if (r.error || !r.results || !r.results.length) { list.classList.add('hidden'); list.innerHTML = ''; return; }
        list.innerHTML = r.results.map((res, i) =>
          `<div class="ac-item" data-i="${i}"><span class="ac-l">${esc(res.label)}</span><span class="ac-c">${esc(res.context || '')}</span></div>`
        ).join('');
        list._results = r.results;
        list.classList.remove('hidden');
      }, 260);
    });

    list.addEventListener('click', (e) => {
      const item = e.target.closest('.ac-item');
      if (!item) return;
      const res = list._results[+item.dataset.i];
      if (!res) return;
      input.value = res.label;
      CC.trajets['_' + which] = { lat: res.lat, lon: res.lon, label: res.label };
      list.classList.add('hidden');
    });

    // Fermer la liste si on clique ailleurs
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#' + listId) && e.target !== input) list.classList.add('hidden');
    });
  },

  // Résout un point : coords sélectionnées, sinon géocode le texte saisi
  async resolvePoint(inputId, which) {
    const sel = CC.trajets['_' + which];
    if (sel) return sel;
    const input = document.getElementById(inputId);
    const q = (input.value || '').trim();
    if (q.length < 3) return null;
    const r = await window.api.routes.geocode(q);
    if (r.error || !r.results || !r.results.length) return null;
    const best = r.results[0];
    input.value = best.label;
    CC.trajets['_' + which] = { lat: best.lat, lon: best.lon, label: best.label };
    return CC.trajets['_' + which];
  },

  _setSaveEnabled(on) {
    const b = document.getElementById('tj_save');
    if (b) b.disabled = !on;
  },

  // ---- Calcul d'un trajet ----
  async calc() {
    const spin = document.getElementById('tj_spin');
    const out = document.getElementById('tj_result');
    spin.classList.remove('hidden');
    CC.trajets._setSaveEnabled(false);
    try {
      const from = await CC.trajets.resolvePoint('tj_from', 'from');
      const to = await CC.trajets.resolvePoint('tj_to', 'to');
      if (!from) { CC.toast('Adresse de départ introuvable.', 'err'); return; }
      if (!to) { CC.toast('Adresse d\'arrivée introuvable.', 'err'); return; }

      const ar = document.getElementById('tj_ar').checked;
      const count = Math.max(1, parseInt(document.getElementById('tj_count').value, 10) || 1);
      const vehicleType = document.getElementById('tj_vehicle').value;
      const mult = (ar ? 2 : 1) * count;

      const rt = await window.api.routes.route({ from, to });
      if (rt.error) { out.innerHTML = `<div class="alert danger"><span class="ai">!</span><div>${esc(rt.error)}</div></div>`; return; }

      const kmOneWay = rt.distance / 1000;
      const km = kmOneWay * mult;
      const tarif = (CC.state.settings.tarifKm != null ? CC.state.settings.tarifKm : 0.636);
      const indemnite = km * tarif;

      // Estimation du coût carburant réel (informatif, non ajouté au total déductible)
      const prixCarb = (CC.state.settings.prixCarburant != null ? CC.state.settings.prixCarburant : 1.90);
      const consoL100 = (CC.state.settings.consoL100 != null ? CC.state.settings.consoL100 : 6.5);
      const carburant = (km / 100) * consoL100 * prixCarb;

      // Péages (facultatif : ne bloque pas le calcul de l'indemnité)
      let peage = 0, tollNote = '';
      const wantTolls = !!(document.getElementById('tj_tolls') && document.getElementById('tj_tolls').checked);
      if (!wantTolls) {
        tollNote = 'Péages non calculés (option décochée).';
      } else if (CC._tollQuotaHit) {
        tollNote = 'Quota TollGuru du jour atteint — péages non calculés.';
      } else {
        const key = `${from.lat},${from.lon}|${to.lat},${to.lon}|${vehicleType}`;
        let tr = CC.trajets._tollCache[key];
        if (!tr) {
          tr = await window.api.routes.tolls({ from, to, vehicleType });
          if (!tr.error) CC.trajets._tollCache[key] = tr;   // on ne cache que les succès
        }
        if (tr.error === 'no-key') {
          tollNote = 'Péages non calculés (clé TollGuru manquante).';
        } else if (tr.error) {
          if (/quota|exceeded|denied/i.test(tr.error)) {
            CC._tollQuotaHit = true;   // on arrête d'interroger TollGuru pour aujourd'hui
            tollNote = 'Quota TollGuru du jour atteint (15/jour en gratuit) — péages non calculés.';
          } else {
            tollNote = 'Péages indisponibles : ' + tr.error;
          }
        } else if (!tr.hasTolls) {
          tollNote = 'Aucun péage sur cet itinéraire.';
        } else {
          peage = (tr.cost || 0) * mult;
        }
      }

      // Total frais = coût réel décaissé : carburant + péages (l'indemnité barème reste à part)
      const total = carburant + peage;
      // Temps de route : durée renvoyée par le routeur (aller simple) puis totale
      // (aller-retour × nombre de trajets), pour refléter le temps réellement passé.
      const durOneWay = rt.duration || 0;
      const durTotal = durOneWay * mult;
      CC.trajets.drawRoute(rt.geometry, from, to);
      CC.trajets.showResult({ from, to, kmOneWay, km, ar, count, tarif, indemnite, peage, total, carburant, prixCarb, consoL100, duration: rt.duration, durOneWay, durTotal, tollNote, vehicleType });
      CC.trajets._last = { from, to, kmOneWay, km, ar, count, tarif, indemnite, peage, total, carburant, vehicleType, durOneWay, durTotal };
      CC.trajets._setSaveEnabled(true);
    } finally {
      spin.classList.add('hidden');
    }
  },

  drawRoute(geometry, from, to) {
    const map = CC.trajets._map;
    if (!map || typeof L === 'undefined') return;
    if (CC.trajets._routeCasing) { map.removeLayer(CC.trajets._routeCasing); CC.trajets._routeCasing = null; }
    if (CC.trajets._route) { map.removeLayer(CC.trajets._route); CC.trajets._route = null; }
    CC.trajets._markers.forEach((m) => map.removeLayer(m));
    CC.trajets._markers = [];

    const latlngs = (geometry || []).map((c) => [c[1], c[0]]);   // [lon,lat] -> [lat,lon]
    if (latlngs.length) {
      // Liseré blanc sous le tracé (effet « carte de navigation » moderne)
      CC.trajets._routeCasing = L.polyline(latlngs, { color: '#ffffff', weight: 9, opacity: 0.9, lineJoin: 'round', lineCap: 'round' }).addTo(map);
      CC.trajets._route = L.polyline(latlngs, { color: '#4f46e5', weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round' }).addTo(map);
    }
    const mk = (pt, cls) => L.marker([pt.lat, pt.lon], {
      icon: L.divIcon({ className: '', html: `<span class="tj-pin ${cls}"></span>`, iconSize: [18, 18], iconAnchor: [9, 9] })
    }).addTo(map);
    CC.trajets._markers.push(mk(from, 'a'), mk(to, 'b'));

    if (CC.trajets._route) map.fitBounds(CC.trajets._route.getBounds().pad(0.15));
    else map.fitBounds(L.latLngBounds([[from.lat, from.lon], [to.lat, to.lon]]).pad(0.2));
  },

  showResult(d) {
    const out = document.getElementById('tj_result');
    const arTxt = d.ar ? 'aller-retour' : 'aller simple';
    const cntTxt = d.count > 1 ? ` × ${d.count}` : '';
    const peageTxt = d.peage > 0 ? CC.util.eur(d.peage) : (d.tollNote ? '—' : CC.util.eur(0));
    const carbHint = (d.consoL100 != null && d.prixCarb != null)
      ? `${String(d.consoL100).replace('.', ',')} L/100 · ${String(d.prixCarb).replace('.', ',')} €/L`
      : 'estimation';
    const durOneWay = (d.durOneWay != null ? d.durOneWay : d.duration) || 0;
    const durTotal = (d.durTotal != null ? d.durTotal : durOneWay);
    const durHint = (durTotal > durOneWay)
      ? `${durFmt(durOneWay)} aller · ${arTxt}${cntTxt}`
      : 'temps de conduite estimé';
    out.innerHTML = `
      <div class="tj-kpis">
        <div class="kpi blue"><div class="label">Distance</div><div class="value">${kmFmt(d.km)}</div><div class="hint">${kmFmt(d.kmOneWay)} aller · ${arTxt}${cntTxt}</div></div>
        <div class="kpi indigo"><div class="label">Temps de route</div><div class="value">${durFmt(durTotal)}</div><div class="hint">${durHint}</div></div>
        <div class="kpi green"><div class="label">Indemnité km</div><div class="value">${CC.util.eur(d.indemnite)}</div><div class="hint">${d.tarif.toString().replace('.', ',')} €/km</div></div>
        <div class="kpi amber"><div class="label">Péages</div><div class="value">${peageTxt}</div><div class="hint">${esc(d.tollNote || 'estimés TollGuru')}</div></div>
        <div class="kpi blue"><div class="label">Carburant estimé</div><div class="value">${CC.util.eur(d.carburant || 0)}</div><div class="hint">${carbHint}</div></div>
        <div class="kpi green"><div class="label">Total frais</div><div class="value">${CC.util.eur(d.total)}</div><div class="hint">carburant + péages</div></div>
      </div>`;
  },

  save() {
    const d = CC.trajets._last;
    if (!d) return;
    const motif = (document.getElementById('tj_motif').value || '').trim();
    CC.state.trajets.push({
      id: CC.util.uid(),
      date: CC.util.toISO(new Date()),
      from: d.from.label, to: d.to.label,
      kmOneWay: d.kmOneWay, allerRetour: d.ar, count: d.count, km: d.km,
      tarifKm: d.tarif, indemnite: d.indemnite, peage: d.peage, carburant: d.carburant, total: d.total,
      vehicleType: d.vehicleType, motif
    });
    CC.markDirty();
    CC.trajets.renderList();
    CC.trajets._setSaveEnabled(false);
    CC.toast('Trajet enregistré.', 'ok');
  },

  removeTrajet(id) {
    CC.state.trajets = CC.state.trajets.filter((t) => t.id !== id);
    CC.markDirty();
    CC.trajets.renderList();
  },

  renderList() {
    const body = document.getElementById('trajetsBody');
    const empty = document.getElementById('trajetsEmpty');
    if (!body) return;
    const list = (CC.state.trajets || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    let tKm = 0, tInd = 0, tPea = 0, tCarb = 0, tTot = 0;
    body.innerHTML = list.map((t) => {
      tKm += +t.km || 0; tInd += +t.indemnite || 0; tPea += +t.peage || 0; tCarb += +t.carburant || 0; tTot += +t.total || 0;
      const trajet = `${esc(short(t.from))} → ${esc(short(t.to))}` + (t.motif ? `<div class="tj-motif">${esc(t.motif)}</div>` : '');
      const tag = (t.allerRetour ? 'A/R' : 'aller') + (t.count > 1 ? ' ×' + t.count : '');
      return `<tr>
        <td class="fmeta">${CC.util.frDate(t.date)}</td>
        <td class="client">${trajet} <span class="cat-chip">${tag}</span></td>
        <td class="num">${kmFmt(t.km)}</td>
        <td class="num">${CC.util.eur(t.indemnite)}</td>
        <td class="num">${t.carburant > 0 ? CC.util.eur(t.carburant) : '—'}</td>
        <td class="num">${t.peage > 0 ? CC.util.eur(t.peage) : '—'}</td>
        <td class="num montant">${CC.util.eur(t.total)}</td>
        <td class="col-actions"><button class="mini-btn" data-del="${t.id}">Suppr.</button></td>
      </tr>`;
    }).join('');
    empty.classList.toggle('hidden', list.length > 0);
    const tot = document.getElementById('tj_total');
    if (tot) tot.textContent = list.length
      ? `${list.length} trajet(s) — ${kmFmt(tKm)} · Indemnité ${CC.util.eur0(tInd)} · Carburant ${CC.util.eur0(tCarb)} · Péages ${CC.util.eur0(tPea)} · Total ${CC.util.eur0(tTot)}`
      : '';
  },

  bind() {
    CC.trajets.bindAutocomplete('tj_from', 'tj_fromList', 'from');
    CC.trajets.bindAutocomplete('tj_to', 'tj_toList', 'to');
    const calc = document.getElementById('tj_calc');
    if (calc) calc.addEventListener('click', () => CC.trajets.calc());
    const save = document.getElementById('tj_save');
    if (save) save.addEventListener('click', () => CC.trajets.save());
    const veh = document.getElementById('tj_vehicle');
    if (veh) veh.value = CC.state.settings.vehicleType || '2AxlesAuto';
    // Carburant : prix au litre + consommation -> mémorisés dans les paramètres
    const fuelPrice = document.getElementById('tj_fuelPrice');
    if (fuelPrice) fuelPrice.addEventListener('change', (e) => {
      let v = parseFloat(String(e.target.value).replace(',', '.'));
      if (isNaN(v) || v < 0) v = 0;
      CC.state.settings.prixCarburant = v; CC.markDirty();
    });
    const fuelConso = document.getElementById('tj_fuelConso');
    if (fuelConso) fuelConso.addEventListener('change', (e) => {
      let v = parseFloat(String(e.target.value).replace(',', '.'));
      if (isNaN(v) || v < 0) v = 0;
      CC.state.settings.consoL100 = v; CC.markDirty();
    });
    const tolls = document.getElementById('tj_tolls');
    if (tolls) tolls.addEventListener('change', (e) => { CC.state.settings.calcTolls = e.target.checked; CC.markDirty(); });
    const body = document.getElementById('trajetsBody');
    if (body) body.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-del]');
      if (b) CC.trajets.removeTrajet(b.dataset.del);
    });
  }
};

function kmFmt(n) { return (Math.round((+n || 0) * 10) / 10).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' km'; }
function durFmt(s) {
  s = Math.round(+s || 0);
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}
function short(s) { return (s || '').split(',')[0]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
