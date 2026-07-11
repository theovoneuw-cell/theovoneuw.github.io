'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Utilitaires partages
// ---------------------------------------------------------------------------
CC.util = {
  eur(n) {
    if (CC.state && CC.state.privacy) return '••• €';
    if (n == null || isNaN(n)) n = 0;
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n);
  },
  eur0(n) {
    if (CC.state && CC.state.privacy) return '••• €';
    if (n == null || isNaN(n)) n = 0;
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
  },
  pct(n, dec = 1) {
    if (CC.state && CC.state.privacy) return '••• %';
    if (n == null || isNaN(n)) n = 0;
    return n.toFixed(dec).replace('.', ',') + ' %';
  },
  num(n) { return new Intl.NumberFormat('fr-FR').format(n || 0); },
  // Diagnostic connexion : distingue une VRAIE coupure réseau d'une SESSION Google
  // expirée. Sur iPhone, le jeton Google (~1 h) ne se renouvelle pas toujours en
  // silence : Gmail/Agenda échouent alors que le réseau (et Gemini) fonctionnent.
  netKind(err) {
    const s = String(err || '');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    if (/connexion internet|injoignable|réseau|network|failed to fetch|load failed/i.test(s)) return 'offline';
    if (/connect|autoris|reconnect|expir|insuffisante|401|403/i.test(s)) return 'auth';
    return 'other';
  },
  parseDate(s) {
    if (!s) return null;
    const d = new Date(s + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  },
  toISO(d) {
    if (!d) return '';
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  },
  frDate(s) {
    const d = CC.util.parseDate(s);
    return d ? d.toLocaleDateString('fr-FR') : '';
  },
  addDays(d, days) { const r = new Date(d); r.setDate(r.getDate() + days); return r; },
  daysBetween(a, b) { return Math.round((b - a) / 86400000); },
  trimestreOfDate(s) { const d = CC.util.parseDate(s); return d ? Math.floor(d.getMonth() / 3) + 1 : null; },
  yearOf(s) { const d = CC.util.parseDate(s); return d ? d.getFullYear() : null; },

  // Normalisation d'un nom de client (regroupe les variantes)
  ALIASES: {
    'LES CHENES': 'IME LES CHENES',
    'STUDIO M (STUDIO)': 'STUDIO M',
    'FONDATION DE NICE': 'FONDATION DE NICE',
    'FONDATION LENVAL': 'FONDATION LENVAL'
  },
  clientKey(libelle) {
    if (!libelle) return '(SANS NOM)';
    const raw = libelle.split(/—|–| - |,|\//)[0];
    const n = raw.normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/\s+/g, ' ').trim();
    return CC.util.ALIASES[n] || n;
  },
  uid() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
};

CC.MOIS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
CC.TRIMS = ['T1', 'T2', 'T3', 'T4'];

// ---------------------------------------------------------------------------
// Parametres par defaut (taux URSSAF par trimestre, base sur les vrais chiffres)
// ---------------------------------------------------------------------------
CC.defaultSettings = function () {
  return {
    urssafRates: {
      2024: [23.4, 23.4, 25.4, 25.4],
      2025: [24.7, 24.7, 24.7, 25.4],
      2026: [25.6, 25.6, 25.6, 25.6]
    },
    defaultUrssafRate: 26.1,   // annees non renseignees
    tauxFraisAnnexes: 0.155,   // CFP + taxe CCI/CMA : s'ajoutent au taux de cotisations (≈ 0,155 % du CA)
    versementActif: false,
    tauxImpot: 2.2,
    abattementBNC: 34,         // abattement forfaitaire micro-BNC
    tmi: 0,                    // tranche marginale d'imposition (optionnel)
    seuilTvaBase: 37500,       // franchise TVA prestations de services 2025/2026
    seuilTvaMajore: 41250,
    delaiPaiement: 30,
    plafond: 0,                // 0 = automatique selon l'annee
    objectif: 0,
    // --- Integrations (non sensible ; les cles/jetons sont stockes chiffres a part) ---
    aiModel: 'gemini-2.0-flash',
    mailSignature: '',         // signature ajoutee aux mails generes
    mailTon: 'cordial',        // ton par defaut : pro | cordial | ferme
    // --- Frais kilometriques ---
    adresseDepart: '3 impasse Anahit 06200 Nice',   // depart pre-rempli dans Trajets
    chevauxFiscaux: 5,         // puissance fiscale (determine le tarif par defaut)
    tarifKm: 0.636,            // bareme kilometrique (EUR/km) editable
    vehicleType: '2AxlesAuto', // type vehicule TollGuru (voiture) | 2AxlesMotorcycle (moto)
    prixCarburant: 1.90,       // prix du carburant (EUR/litre) pour l'estimation du cout reel
    consoL100: 6.5,            // consommation moyenne (litres / 100 km)
    calcTolls: true            // interroger TollGuru pour les peages (consomme le quota)
  };
};

// Bareme kilometrique forfaitaire simplifie (EUR/km, 1re tranche <= 5000 km).
// Voiture, bareme 2024. Sert a pre-remplir le tarif selon les chevaux fiscaux.
CC.BAREME_KM = { 3: 0.529, 4: 0.606, 5: 0.636, 6: 0.665, 7: 0.697 };
CC.baremeKm = function (cv) {
  const c = Math.max(3, Math.min(7, parseInt(cv, 10) || 5));
  return CC.BAREME_KM[c];
};

// Plafond micro-BNC : 77 700 jusqu'en 2025, 83 600 a partir de 2026
CC.plafondMicro = function (year) { return year >= 2026 ? 83600 : 77700; };
CC.effPlafond = function (year) {
  const o = CC.state && CC.state.settings ? CC.state.settings.plafond : 0;
  return (o && o > 0) ? o : CC.plafondMicro(year);
};

// Categories d'activite + classement automatique par mots-cles du libelle
// L'ordre compte : la premiere regle qui correspond gagne.
CC.CATEGORIES = ['Cours et Enseignement', 'Mixage/Mastering', 'AMU Social', 'Ateliers Musiques Urbaines', 'Associatif / Fondations', 'Autre'];
CC.CAT_RULES = [
  ['Cours et Enseignement', ['STUDIO M', 'COURS', 'ENSEIGNEMENT', 'PORTFOLIO', 'JURY', 'PODCAST']],
  ['Mixage/Mastering', ['MIXAGE', 'MASTERING', 'MASTER', 'EDIAG', 'HANECOBA', 'GIANO', 'MIX ', 'MIX-']],
  ['AMU Social', ['IME', 'SESSAD', 'VAL PAILLON', 'CHENES', 'CHÊNES', 'LIEU RESSOURCE']],
  ['Associatif / Fondations', ['FONDATION', 'ASSO', 'FOL', 'NAVVA', 'TRESORERIE', 'TRÉSORERIE', 'LENVAL', 'VALDOCCO']],
  ['Ateliers Musiques Urbaines', ['ATELIER', 'MUSIQUES URBAINES', 'EJ ', 'ESPACE JEUNE', 'SIVOM', 'MAIRIE', 'VILLE DE', 'DRAP', 'FALICON', 'COLOMARS', 'BLAISE', 'MARTIN', 'CASTAGNIERS', 'ASPREMONT', 'LEVENS', 'ANDRE', 'ANDRÉ', 'SANARY', 'ANTIBES', 'PIERREFEU', 'COLLOBRIERES', 'BORMES', 'NICE', 'ANIMANICE', 'MAGNAN', 'SD ', 'ACM']]
];
CC.util.categoryOf = function (libelle) {
  const n = (libelle || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  for (const [cat, kws] of CC.CAT_RULES) { if (kws.some((k) => n.includes(k))) return cat; }
  return 'Autre';
};

// Taux global de prélèvement URSSAF applicable a une annee/trimestre donnes.
// = taux de cotisations sociales (tableau) + frais annexes (CFP + taxe CCI/CMA),
// afin que l'estimation colle au "Total des cotisations et contributions" réel.
CC.urssafRate = function (year, trimestre) {
  const s = CC.state.settings;
  const row = s.urssafRates[year];
  let base;
  if (row && row[trimestre - 1] != null && !isNaN(row[trimestre - 1])) base = row[trimestre - 1];
  else base = s.defaultUrssafRate || 0;
  const frais = (s.tauxFraisAnnexes != null && !isNaN(s.tauxFraisAnnexes)) ? s.tauxFraisAnnexes : 0.155;
  return Math.round((base + frais) * 1000) / 1000;   // 3 décimales : garde la précision CFP/CCI
};

// ---------------------------------------------------------------------------
// Rendu de l'onglet Parametres
// ---------------------------------------------------------------------------
CC.renderSettings = function () {
  const s = CC.state.settings;
  document.getElementById('setVersementActif').checked = !!s.versementActif;
  document.getElementById('setTauxImpot').value = s.tauxImpot;
  document.getElementById('setAbattement').value = s.abattementBNC;
  document.getElementById('setTmi').value = s.tmi || '';
  document.getElementById('setSeuilTvaBase').value = s.seuilTvaBase;
  document.getElementById('setSeuilTvaMajore').value = s.seuilTvaMajore;
  document.getElementById('setDelai').value = s.delaiPaiement;
  document.getElementById('setPlafond').value = s.plafond || '';
  document.getElementById('setObjectif').value = s.objectif || '';
  document.getElementById('setDefaultRate').value = s.defaultUrssafRate;
  const fa = document.getElementById('setFraisAnnexes');
  if (fa) fa.value = (s.tauxFraisAnnexes != null ? s.tauxFraisAnnexes : 0.155);
  CC.renderUrssafTable();
};

// Tableau editable des taux URSSAF par trimestre
CC.renderUrssafTable = function () {
  const s = CC.state.settings;
  const years = new Set(Object.keys(s.urssafRates).map(Number));
  CC.stats.years(CC.state.factures).forEach((y) => years.add(y));
  years.add(new Date().getFullYear());
  const list = Array.from(years).sort((a, b) => a - b);

  let html = '<table class="rate-table"><thead><tr><th>Année</th><th>T1</th><th>T2</th><th>T3</th><th>T4</th></tr></thead><tbody>';
  list.forEach((y) => {
    const row = s.urssafRates[y] || [];
    html += `<tr><td class="ry">${y}</td>` + [0, 1, 2, 3].map((i) => {
      const v = (row[i] != null && !isNaN(row[i])) ? row[i] : '';
      return `<td><input type="number" step="0.1" min="0" max="100" class="rate-input mask-amount" data-year="${y}" data-tri="${i}" value="${v}" placeholder="${s.defaultUrssafRate}"></td>`;
    }).join('') + '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('urssafTable').innerHTML = html;

  document.querySelectorAll('.rate-input').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      const y = e.target.dataset.year, i = +e.target.dataset.tri;
      if (!s.urssafRates[y]) s.urssafRates[y] = [];
      const v = parseFloat(e.target.value);
      s.urssafRates[y][i] = isNaN(v) ? null : v;
      CC.markDirty();
      CC.render();
    });
  });
};

CC.bindSettings = function () {
  const map = {
    setTauxImpot: ['tauxImpot', 'num'],
    setAbattement: ['abattementBNC', 'num'],
    setTmi: ['tmi', 'num'],
    setSeuilTvaBase: ['seuilTvaBase', 'num'],
    setSeuilTvaMajore: ['seuilTvaMajore', 'num'],
    setDelai: ['delaiPaiement', 'int'],
    setPlafond: ['plafond', 'num'],
    setObjectif: ['objectif', 'num'],
    setDefaultRate: ['defaultUrssafRate', 'num'],
    setFraisAnnexes: ['tauxFraisAnnexes', 'num']
  };
  Object.keys(map).forEach((id) => {
    const [key, type] = map[id];
    document.getElementById(id).addEventListener('change', (e) => {
      let v = type === 'int' ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
      if (isNaN(v)) v = 0;
      CC.state.settings[key] = v;
      CC.markDirty();
      CC.render();
    });
  });
  document.getElementById('setVersementActif').addEventListener('change', (e) => {
    CC.state.settings.versementActif = e.target.checked;
    CC.markDirty();
    CC.render();
  });
};
