'use strict';
window.CC = window.CC || {};

// Modele facture :
//   { id, libelle, montant, modePaiement, numFacture,
//     dateEncaissement (""=non paye), annee, trimestre,
//     dateEnvoi, dateEcheance, notes }

CC.stats = {
  isPaid(f) { return !!f.dateEncaissement; },

  // Une facture est "emise" (reellement facturee/envoyee) si elle a un numero.
  // Sans numero => pas encore envoyee => previsionnel (jamais "en retard").
  isInvoiced(f) { return !!(f.numFacture && String(f.numFacture).trim()); },

  // Periode de reference (annee/trimestre) : la feuille Excel fait foi ;
  // pour une facture payee sans periode explicite, on prend la date d'encaissement.
  yearOf(f) {
    if (f.annee) return +f.annee;
    if (f.dateEncaissement) return CC.util.yearOf(f.dateEncaissement);
    return null;
  },
  trimOf(f) {
    if (f.trimestre) return +f.trimestre;
    if (f.dateEncaissement) return CC.util.trimestreOfDate(f.dateEncaissement);
    return null;
  },

  // Statut : 'recue' (paye) | 'prevu' (pas encore emise, sans n°) | 'attente' | 'retard'
  statut(f, settings, today = new Date()) {
    if (f.dateEncaissement) return 'recue';
    // Pas encore facturee/envoyee (aucun numero) -> previsionnel, jamais en retard
    if (!CC.stats.isInvoiced(f)) return 'prevu';
    if (f.dateEcheance) {
      const ech = CC.util.parseDate(f.dateEcheance);
      if (ech && today > ech) return 'retard';
    } else if (f.dateEnvoi && settings) {
      const ech = CC.util.addDays(CC.util.parseDate(f.dateEnvoi), settings.delaiPaiement || 30);
      if (ech && today > ech) return 'retard';
    }
    return 'attente';
  },

  years(factures) {
    const set = new Set();
    factures.forEach((f) => { const y = CC.stats.yearOf(f); if (y) set.add(y); });
    return Array.from(set).sort((a, b) => a - b);
  },

  forYear(factures, year) {
    if (year === 'all') return factures.slice();
    return factures.filter((f) => CC.stats.yearOf(f) === year);
  },

  // Sommes par statut pour un lot de factures
  // aVenir = factures EMISES non payees (attente + retard) ; prevu = pas encore emises
  sums(factures, settings) {
    let encaisse = 0, attente = 0, retard = 0, prevu = 0, brut = 0;
    const today = new Date();
    factures.forEach((f) => {
      const m = +f.montant || 0; brut += m;
      const st = CC.stats.statut(f, settings, today);
      if (st === 'recue') encaisse += m;
      else if (st === 'retard') retard += m;
      else if (st === 'prevu') prevu += m;
      else attente += m;
    });
    return { brut, encaisse, attente, retard, prevu, aVenir: attente + retard };
  },

  // Encaisse d'un trimestre precis d'une annee
  encaisseTrim(factures, year, trimestre) {
    let s = 0;
    factures.forEach((f) => {
      if (!CC.stats.isPaid(f)) return;
      if (CC.stats.yearOf(f) !== year || CC.stats.trimOf(f) !== trimestre) return;
      s += +f.montant || 0;
    });
    return s;
  },

  encaisseYear(factures, year) {
    let s = 0;
    factures.forEach((f) => { if (CC.stats.isPaid(f) && CC.stats.yearOf(f) === year) s += +f.montant || 0; });
    return s;
  },

  // URSSAF par trimestre (encaisse du trimestre x taux du trimestre)
  urssafByTrim(factures, year) {
    const out = [];
    for (let t = 1; t <= 4; t++) {
      const enc = CC.stats.encaisseTrim(factures, year, t);
      const taux = CC.urssafRate(year, t);
      out.push({ trimestre: t, encaisse: enc, taux, urssaf: enc * taux / 100 });
    }
    return out;
  },

  // CA par categorie d'activite (sur une liste deja filtree par annee)
  caByCategory(factures, paidOnly) {
    const map = new Map();
    factures.forEach((f) => {
      if (paidOnly && !CC.stats.isPaid(f)) return;
      const c = f.categorie || CC.util.categoryOf(f.libelle);
      map.set(c, (map.get(c) || 0) + (+f.montant || 0));
    });
    return Array.from(map.entries()).map(([categorie, total]) => ({ categorie, total })).sort((a, b) => b.total - a.total);
  },

  // Date limite de DECLARATION URSSAF d'un trimestre
  // T1 -> 30/04, T2 -> 31/07, T3 -> 31/10, T4 -> 31/01 (annee+1)
  urssafDeclDeadline(year, trimestre) {
    const map = { 1: new Date(year, 3, 30), 2: new Date(year, 6, 31), 3: new Date(year, 9, 31), 4: new Date(year + 1, 0, 31) };
    return map[trimestre];
  },

  // Date de prelevement URSSAF d'un trimestre (~1 mois apres la declaration)
  // T1 -> mai (meme annee), T2 -> aout, T3 -> novembre, T4 -> fevrier (annee+1)
  urssafDueDate(year, trimestre) {
    const map = { 1: { mois: 4, annee: year }, 2: { mois: 7, annee: year }, 3: { mois: 10, annee: year }, 4: { mois: 1, annee: year + 1 } };
    return map[trimestre];
  },

  // Echeancier des prelevements : toutes les echeances depuis fromYear, triees par date
  urssafSchedule(factures, settings, fromYear) {
    const years = CC.stats.years(factures);
    const minY = fromYear || (years[0] || new Date().getFullYear());
    const maxY = Math.max(new Date().getFullYear(), years[years.length - 1] || 0);
    const today = new Date();
    const out = [];
    for (let y = minY; y <= maxY; y++) {
      CC.stats.urssafByTrim(factures, y).forEach((t) => {
        const due = CC.stats.urssafDueDate(y, t.trimestre);
        const dueDate = new Date(due.annee, due.mois, 5);
        out.push({
          trimestre: t.trimestre, annee: y,
          encaisse: t.encaisse, taux: t.taux, urssaf: t.urssaf,
          due, dueDate,
          statut: dueDate <= today ? 'preleve' : 'a-venir'
        });
      });
    }
    return out.sort((a, b) => a.dueDate - b.dueDate);
  },

  // Cotisations annuelles + net
  cotisationsYear(factures, year, settings) {
    const trims = CC.stats.urssafByTrim(factures, year);
    const urssaf = trims.reduce((a, t) => a + t.urssaf, 0);
    const encaisse = trims.reduce((a, t) => a + t.encaisse, 0);
    const impot = settings.versementActif ? encaisse * (settings.tauxImpot || 0) / 100 : 0;
    return { urssaf, impot, encaisse, net: encaisse - urssaf - impot, trims };
  },

  // Encaisse par mois (12) selon la DATE d'encaissement
  monthlyEncaisse(factures, year) {
    const arr = new Array(12).fill(0);
    factures.forEach((f) => {
      if (!CC.stats.isPaid(f)) return;
      const d = CC.util.parseDate(f.dateEncaissement);
      if (d && d.getFullYear() === year) arr[d.getMonth()] += +f.montant || 0;
    });
    return arr;
  },

  // En attente par trimestre (non paye) selon la periode
  attenteByTrim(factures, year) {
    const arr = [0, 0, 0, 0];
    factures.forEach((f) => {
      if (CC.stats.isPaid(f)) return;
      if (CC.stats.yearOf(f) !== year) return;
      const t = CC.stats.trimOf(f);
      if (t) arr[t - 1] += +f.montant || 0;
    });
    return arr;
  },

  topClients(factures, limit = 8) {
    const map = new Map();
    factures.forEach((f) => {
      const c = CC.util.clientKey(f.libelle);
      const cur = map.get(c) || { client: c, total: 0, paye: 0, count: 0 };
      cur.total += +f.montant || 0;
      if (CC.stats.isPaid(f)) cur.paye += +f.montant || 0;
      cur.count += 1;
      map.set(c, cur);
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, limit);
  },

  avgInvoice(factures) {
    if (!factures.length) return 0;
    return factures.reduce((a, f) => a + (+f.montant || 0), 0) / factures.length;
  },

  // Saisonnalite : encaisse moyen par mois sur toutes les annees
  seasonality(factures) {
    const years = CC.stats.years(factures);
    const totals = new Array(12).fill(0);
    years.forEach((y) => { const m = CC.stats.monthlyEncaisse(factures, y); for (let i = 0; i < 12; i++) totals[i] += m[i]; });
    const n = years.length || 1;
    return totals.map((t) => t / n);
  },

  // Croissance EN TEMPS REEL : cumul encaisse du 1er jan -> aujourd'hui,
  // compare a la meme periode l'an dernier (meme jour/mois).
  yoyRealtime(factures, year) {
    const today = new Date();
    const isCurrent = (year === today.getFullYear());
    // borne = aujourd'hui si annee en cours, sinon 31/12
    const cutMonth = isCurrent ? today.getMonth() : 11;
    const cutDay = isCurrent ? today.getDate() : 31;

    function cumulTo(y) {
      let s = 0;
      factures.forEach((f) => {
        if (!CC.stats.isPaid(f)) return;
        const d = CC.util.parseDate(f.dateEncaissement);
        if (!d || d.getFullYear() !== y) return;
        // <= meme jour/mois
        if (d.getMonth() < cutMonth || (d.getMonth() === cutMonth && d.getDate() <= cutDay)) s += +f.montant || 0;
      });
      return s;
    }
    const cur = cumulTo(year);
    const prev = cumulTo(year - 1);
    if (!prev) return { cur, prev, pct: null, isCurrent };
    return { cur, prev, pct: ((cur - prev) / prev) * 100, isCurrent };
  },

  // Previsionnel annee en cours
  forecast(factures, year, settings) {
    const today = new Date();
    const isCurrent = (year === today.getFullYear());
    const encaisse = CC.stats.encaisseYear(factures, year);
    const aVenir = CC.stats.attenteByTrim(factures, year).reduce((a, b) => a + b, 0);

    const start = new Date(year, 0, 1), end = new Date(year, 11, 31);
    const dayOfYear = isCurrent ? CC.util.daysBetween(start, today) + 1 : 366;
    const totalDays = CC.util.daysBetween(start, end) + 1;

    let projete = encaisse;
    if (isCurrent && dayOfYear > 0) {
      projete = Math.max((encaisse / dayOfYear) * totalDays, encaisse + aVenir);
    }
    // URSSAF projetee : on applique le taux moyen connu de l'annee a la projection
    const trims = CC.stats.urssafByTrim(factures, year);
    const tauxMoyen = (trims.reduce((a, t) => a + t.taux, 0) / 4) / 100;
    const urssafProj = projete * tauxMoyen;
    const impotProj = settings.versementActif ? projete * (settings.tauxImpot || 0) / 100 : 0;
    const netProj = projete - urssafProj - impotProj;

    const yearsPrev = CC.stats.years(factures).filter((y) => y < year);
    const histAvg = yearsPrev.length
      ? yearsPrev.reduce((a, y) => a + CC.stats.encaisseYear(factures, y), 0) / yearsPrev.length : null;

    return { isCurrent, encaisse, aVenir, projete, dayOfYear, totalDays, urssafProj, netProj, histAvg };
  }
};
