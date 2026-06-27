'use strict';
window.CC = window.CC || {};

const AG_MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const AG_JOURS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const AG_CACHE_PREFIX = 'gcalCache:';   // localStorage : dernière synchro par mois

// Palette officielle des "couleurs d'événement" Google Agenda (colorId 1..11).
// On la rend de façon sobre (liseré + fond léger) pour rester dans l'esprit de l'app.
const AG_ACCENT = '#4f46e5';            // couleur par défaut (indigo de l'app)
const GCAL_COLORS = {
  '1':  { nom: 'Lavande',   hex: '#7986cb' },
  '2':  { nom: 'Sauge',     hex: '#33b679' },
  '3':  { nom: 'Raisin',    hex: '#8e24aa' },
  '4':  { nom: 'Flamant',   hex: '#e67c73' },
  '5':  { nom: 'Banane',    hex: '#f6bf26' },
  '6':  { nom: 'Mandarine', hex: '#f4511e' },
  '7':  { nom: 'Paon',      hex: '#039be5' },
  '8':  { nom: 'Graphite',  hex: '#616161' },
  '9':  { nom: 'Myrtille',  hex: '#3f51b5' },
  '10': { nom: 'Basilic',   hex: '#0b8043' },
  '11': { nom: 'Tomate',    hex: '#d50000' }
};
function colorHex(id) { return (GCAL_COLORS[id] && GCAL_COLORS[id].hex) || AG_ACCENT; }
function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---------------------------------------------------------------------------
// Agenda — vue calendrier mensuel (lecture Google Agenda)
//  · clic sur un événement / une journée -> détail
//  · création d'événements (écrit dans Google, donc synchronisé partout)
//  · cache hors-ligne : réaffiche la dernière synchro quand pas de connexion
// ---------------------------------------------------------------------------
CC.agenda = {
  cur: null,        // 1er jour du mois affiche
  _events: {},      // id -> evenement (pour la modale de detail)
  _byDay: {},       // YYYY-MM-DD -> [evenements]
  _offline: false,  // affichage depuis le cache (lecture seule)
  _newColor: '',    // couleur choisie dans le formulaire de création
  _bound: false,

  _month() {
    if (!this.cur) { const n = new Date(); this.cur = new Date(n.getFullYear(), n.getMonth(), 1); }
    return this.cur;
  },

  bind() {
    const $ = (id) => document.getElementById(id);
    $('agendaPrev') && $('agendaPrev').addEventListener('click', () => { const m = CC.agenda._month(); CC.agenda.cur = new Date(m.getFullYear(), m.getMonth() - 1, 1); CC.agenda.render(); });
    $('agendaNext') && $('agendaNext').addEventListener('click', () => { const m = CC.agenda._month(); CC.agenda.cur = new Date(m.getFullYear(), m.getMonth() + 1, 1); CC.agenda.render(); });
    $('agendaToday') && $('agendaToday').addEventListener('click', () => { const n = new Date(); CC.agenda.cur = new Date(n.getFullYear(), n.getMonth(), 1); CC.agenda.render(); });
    $('agendaAdd') && $('agendaAdd').addEventListener('click', () => CC.agenda._openCreate());

    // Clic sur une cellule / un evenement -> detail
    const body = $('agendaBody');
    if (body && !this._bound) {
      body.addEventListener('click', (e) => {
        if (e.target.closest('#agendaRetry')) { CC.agenda.render(); return; }
        const ev = e.target.closest('.cal-ev[data-ev-id]');
        if (ev) { CC.agenda._openEvent(ev.dataset.evId); return; }
        const cell = e.target.closest('.cal-cell.has');
        if (cell) CC.agenda._openDay(cell.dataset.day);
      });
      this._bound = true;
    }

    // Modale (creee une seule fois, en bas du <body>)
    if (!document.getElementById('agendaModal')) {
      const m = document.createElement('div');
      m.id = 'agendaModal';
      m.className = 'modal-backdrop hidden';
      m.innerHTML = '<div class="modal ev-modal"><div id="agendaModalBody"></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', (e) => {
        // Refermer le mini-calendrier si on clique ailleurs dans la modale
        const dpPop = document.getElementById('evDatePop');
        if (dpPop && !dpPop.classList.contains('hidden') && !e.target.closest('#evDateWrap')) dpPop.classList.add('hidden');
        if (e.target.id === 'agendaModal' || e.target.closest('[data-ev-close]')) { CC.agenda._closeModal(); return; }
        const add = e.target.closest('[data-ev-add]');
        if (add) { CC.agenda._openCreate(add.dataset.evAdd); return; }
        const open = e.target.closest('[data-ev-open]');
        if (open) { CC.agenda._openEvent(open.dataset.evOpen); return; }
        const del = e.target.closest('[data-ev-del]');
        if (del) { CC.agenda._deleteEvent(del.dataset.evDel); return; }
        const link = e.target.closest('[data-ev-url]');
        if (link) { e.preventDefault(); window.api.openUrl(link.dataset.evUrl); }
      });
    }
    if (!this._escBound) {
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') CC.agenda._closeModal(); });
      this._escBound = true;
    }
  },

  async render() {
    const m = this._month();
    const title = document.getElementById('agendaTitle');
    if (title) title.textContent = 'Agenda — ' + cap(AG_MOIS[m.getMonth()]) + ' ' + m.getFullYear();

    const body = document.getElementById('agendaBody');
    if (!body) return;

    // Bornes de la grille : lundi de la semaine du 1er -> 6 semaines (42 jours)
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // 0 = lundi
    const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 42);
    const monthKey = monthKeyOf(m);

    body.innerHTML = '<div class="ck-empty">Chargement de l\'agenda…</div>';

    let res;
    try { res = await window.api.gcal.events({ timeMin: gridStart.toISOString(), timeMax: gridEnd.toISOString(), maxResults: 250 }); }
    catch (e) { res = { error: e.message }; }

    // Connexion OK -> on affiche en direct et on met le cache à jour
    if (res && !res.error) {
      const events = res.events || [];
      this._saveCache(monthKey, events);
      this._paint(m, gridStart, events, null);
      return;
    }

    // Erreur -> on tente la dernière synchro en cache (lecture seule)
    const cached = this._loadCache(monthKey);
    if (cached) { this._paint(m, gridStart, cached.events, cached.savedAt); return; }

    // Pas de cache -> messages habituels
    if (/connect/i.test(res.error)) {
      body.innerHTML = `<div class="agenda-empty">Google Agenda n'est pas connecté.<br><button class="btn btn-primary" id="agendaConnect" style="margin-top:12px">Connecter Google Agenda</button></div>`;
      const b = document.getElementById('agendaConnect');
      if (b) b.addEventListener('click', () => CC.switchTab('settings'));
    } else {
      body.innerHTML = `<div class="agenda-empty">Agenda indisponible : ${esc(res.error)}</div>`;
    }
  },

  // Construit et affiche la grille (en direct ou depuis le cache)
  _paint(m, gridStart, events, savedAt) {
    const body = document.getElementById('agendaBody');
    if (!body) return;
    this._offline = !!savedAt;

    // Regroupe par jour + index par id
    const byDay = {};
    this._events = {};
    (events || []).forEach((e) => {
      const d = new Date(e.debut);
      if (isNaN(d.getTime())) return;
      const key = keyOf(d);
      (byDay[key] = byDay[key] || []).push(e);
      if (e.id) this._events[e.id] = e;
    });
    this._byDay = byDay;

    const todayKey = keyOf(new Date());
    let html = '';
    if (savedAt) {
      html += `<div class="agenda-offline">
        <span class="ao-ic">⚠</span>
        <div>Hors connexion — affichage de la dernière synchronisation du <b>${esc(frDateTime(savedAt))}</b>. Actualisation impossible.</div>
        <button class="lnk" id="agendaRetry">Réessayer</button>
      </div>`;
    }
    html += '<div class="cal">';
    html += '<div class="cal-head">' + AG_JOURS.map((j) => `<div class="cal-hd">${j}</div>`).join('') + '</div>';
    html += '<div class="cal-grid">';
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const inMonth = d.getMonth() === m.getMonth();
      const key = keyOf(d);
      const evs = (byDay[key] || []).sort((a, b) => String(a.debut).localeCompare(String(b.debut)));
      const isToday = key === todayKey;
      const shown = evs.slice(0, 3).map((e) => {
        const hex = colorHex(e.couleur);
        const h = e.journee ? '' : `<span class="cal-h" style="color:${hex}">${heure(e.debut)}</span> `;
        const style = `style="background:${hexA(hex, 0.13)};border-left:3px solid ${hex}"`;
        return `<div class="cal-ev" data-ev-id="${esc(e.id)}" ${style} title="Voir le détail">${h}${esc(e.titre)}</div>`;
      }).join('');
      const more = evs.length > 3 ? `<div class="cal-more">+${evs.length - 3} autre(s)</div>` : '';
      html += `<div class="cal-cell${inMonth ? '' : ' out'}${isToday ? ' today' : ''}${evs.length ? ' has' : ''}" data-day="${key}">
        <div class="cal-num">${d.getDate()}</div>${shown}${more}</div>`;
    }
    html += '</div></div>';
    body.innerHTML = html;
  },

  // ----- Cache local (localStorage) -----
  _saveCache(monthKey, events) {
    try { localStorage.setItem(AG_CACHE_PREFIX + monthKey, JSON.stringify({ savedAt: new Date().toISOString(), events })); } catch (_) {}
  },
  _loadCache(monthKey) {
    try { const raw = localStorage.getItem(AG_CACHE_PREFIX + monthKey); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  },

  // ----- Modale : detail d'un evenement -----
  _openEvent(id) {
    const e = this._events[id];
    if (!e) return;
    const d = new Date(e.debut);
    const dateStr = isNaN(d.getTime()) ? '' : cap(d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    let horaire;
    if (e.journee) horaire = 'Toute la journée';
    else { const h1 = heure(e.debut), h2 = e.fin ? heure(e.fin) : ''; horaire = h2 ? `${h1} – ${h2}` : h1; }

    const rows = [];
    rows.push(metaRow('🗓️', `${dateStr}${horaire ? ' · ' + horaire : ''}`));
    if (e.lieu) {
      const url = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(e.lieu);
      rows.push(`<div class="ev-meta"><span class="ev-ic">📍</span><a href="#" data-ev-url="${esc(url)}" class="lnk">${esc(e.lieu)}</a></div>`);
    }
    let descHtml = '';
    if (e.description) descHtml = `<div class="ev-desc">${esc(e.description)}</div>`;

    // Suppression possible uniquement en ligne (le cache est en lecture seule).
    const delBtn = this._offline ? '' : `<button class="btn btn-danger" data-ev-del="${esc(e.id)}">Supprimer</button>`;
    const actions = [];
    if (e.lien) actions.push(`<button class="btn btn-primary" data-ev-url="${esc(e.lien)}">Ouvrir dans Google Agenda</button>`);
    actions.push('<button class="btn" data-ev-close>Fermer</button>');

    this._show(`
      <div class="ev-head">
        <h2><span class="ev-dot" style="background:${colorHex(e.couleur)}"></span>${esc(e.titre)}</h2>
        <button class="ev-x" data-ev-close title="Fermer">✕</button>
      </div>
      ${rows.join('')}
      ${descHtml}
      <div class="modal-actions">${delBtn}<span class="spacer"></span>${actions.join('')}</div>
    `);
  },

  // ----- Suppression d'un événement -----
  async _deleteEvent(id) {
    const e = this._events[id];
    if (!e) return;
    if (this._offline) { CC.toast('Hors connexion : impossible de supprimer un événement.', 'err'); return; }
    let res;
    try {
      res = await CC.dialog({
        type: 'warning',
        buttons: ['Annuler', 'Supprimer'],
        defaultId: 1, cancelId: 0,
        title: 'Supprimer l\'événement',
        message: `Supprimer « ${e.titre} » de Google Agenda ?`,
        detail: 'Cette action est définitive et se répercute partout (téléphone, web…).'
      });
    } catch (_) { res = { response: 0 }; }
    if (!res || res.response !== 1) return;

    let r;
    try { r = await window.api.gcal.remove(id); }
    catch (err) { r = { error: String(err.message || err) }; }
    if (r && r.error) { CC.toast(r.error, 'err'); return; }

    CC.toast('Événement supprimé ✓', 'ok');
    this._closeModal();
    this.render();
    if (CC.renderToday) CC.renderToday();
  },

  // ----- Modale : liste des evenements d'un jour -----
  _openDay(key) {
    const evs = (this._byDay[key] || []).slice().sort((a, b) => String(a.debut).localeCompare(String(b.debut)));
    const [y, mo, da] = key.split('-').map(Number);
    const dateStr = cap(new Date(y, mo - 1, da).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    const list = evs.map((e) => {
      const h = e.journee ? 'journée' : heure(e.debut);
      return `<div class="ev-item" data-ev-open="${esc(e.id)}">
        <div class="ev-item-time">${h}</div>
        <div class="ev-item-main">
          <div class="ev-item-t"><span class="ev-dot" style="background:${colorHex(e.couleur)}"></span>${esc(e.titre)}</div>
          ${e.lieu ? `<div class="ev-item-s">${esc(e.lieu)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    const addBtn = this._offline ? '' : `<button class="btn btn-primary" data-ev-add="${key}">+ Ajouter ce jour</button>`;
    this._show(`
      <div class="ev-head">
        <h2>${dateStr}</h2>
        <button class="ev-x" data-ev-close title="Fermer">✕</button>
      </div>
      <p class="card-sub">${evs.length} événement(s)</p>
      <div class="ev-list">${list}</div>
      <div class="modal-actions"><span class="spacer"></span>${addBtn}<button class="btn" data-ev-close>Fermer</button></div>
    `);
  },

  // ----- Modale : créer un événement -----
  _openCreate(dateKey) {
    if (this._offline) { CC.toast('Hors connexion : impossible d\'ajouter un événement.', 'err'); return; }
    const day = dateKey || keyOf(new Date());
    this._show(`
      <div class="ev-head">
        <h2>Nouvel événement</h2>
        <button class="ev-x" data-ev-close title="Fermer">✕</button>
      </div>
      <div class="ev-form">
        <label class="ev-f">Titre<input id="evTitre" type="text" placeholder="Ex. Atelier IME Les Chênes" maxlength="200"></label>
        <div class="ev-f-row">
          <div class="ev-f">Date
            <div class="dp" id="evDateWrap">
              <button type="button" class="dp-field" id="evDateBtn"></button>
              <input type="hidden" id="evDate" value="${day}">
              <div class="dp-pop hidden" id="evDatePop"></div>
            </div>
          </div>
          <label class="ev-f ev-check"><input id="evAllDay" type="checkbox"> Toute la journée</label>
        </div>
        <div class="ev-f-row" id="evHeures">
          <label class="ev-f">Début<input id="evDebut" type="time" value="09:00"></label>
          <label class="ev-f">Fin<input id="evFin" type="time" value="10:00"></label>
        </div>
        <label class="ev-f">Lieu<input id="evLieu" type="text" placeholder="(optionnel)"></label>
        <label class="ev-f">Description<textarea id="evDesc" rows="3" placeholder="(optionnel)"></textarea></label>
        <div class="ev-f">Couleur
          <div class="ev-colors" id="evColors">
            <button type="button" class="ev-sw active" data-color="" title="Par défaut" style="--sw:${AG_ACCENT}"></button>
            ${Object.keys(GCAL_COLORS).map((id) => `<button type="button" class="ev-sw" data-color="${id}" title="${GCAL_COLORS[id].nom}" style="--sw:${GCAL_COLORS[id].hex}"></button>`).join('')}
          </div>
        </div>
      </div>
      <div class="modal-actions"><span class="spacer"></span>
        <button class="btn" data-ev-close>Annuler</button>
        <button class="btn btn-primary" id="evSave">Enregistrer dans Google Agenda</button>
      </div>
    `);
    // Mini-calendrier maison (remplace le sélecteur de date natif)
    this._dpInit(day);
    const dpWrap = document.getElementById('evDateWrap');
    if (dpWrap) dpWrap.addEventListener('click', (ev) => {
      if (ev.target.closest('#evDateBtn')) { CC.agenda._dpToggle(); return; }
      const nav = ev.target.closest('[data-dp-nav]');
      if (nav) { const m = CC.agenda._dpView; CC.agenda._dpView = new Date(m.getFullYear(), m.getMonth() + parseInt(nav.dataset.dpNav, 10), 1); CC.agenda._dpRenderPop(); return; }
      const dd = ev.target.closest('[data-dp-day]');
      if (dd) { CC.agenda._dpValue = dd.dataset.dpDay; CC.agenda._dpLabel(); CC.agenda._dpToggle(false); }
    });

    const allDay = document.getElementById('evAllDay');
    const heures = document.getElementById('evHeures');
    allDay.addEventListener('change', () => { heures.style.display = allDay.checked ? 'none' : ''; });
    this._newColor = '';
    const colors = document.getElementById('evColors');
    if (colors) colors.addEventListener('click', (ev) => {
      const sw = ev.target.closest('.ev-sw');
      if (!sw) return;
      colors.querySelectorAll('.ev-sw').forEach((s) => s.classList.remove('active'));
      sw.classList.add('active');
      CC.agenda._newColor = sw.dataset.color || '';
    });
    document.getElementById('evSave').addEventListener('click', () => CC.agenda._saveEvent());
    setTimeout(() => { const t = document.getElementById('evTitre'); if (t) t.focus(); }, 60);
  },

  async _saveEvent() {
    const v = (id) => document.getElementById(id);
    const titre = v('evTitre').value.trim();
    if (!titre) { CC.toast('Donne un titre à l\'événement.', 'err'); v('evTitre').focus(); return; }
    const date = v('evDate').value;
    if (!date) { CC.toast('Choisis une date.', 'err'); return; }

    const event = { summary: titre };
    const lieu = v('evLieu').value.trim(); if (lieu) event.location = lieu;
    const desc = v('evDesc').value.trim(); if (desc) event.description = desc;
    if (this._newColor) event.colorId = this._newColor;

    const [y, mo, da] = date.split('-').map(Number);
    if (v('evAllDay').checked) {
      event.start = { date };
      event.end = { date: keyOf(new Date(y, mo - 1, da + 1)) };
    } else {
      const [h1, m1] = (v('evDebut').value || '09:00').split(':').map(Number);
      const [h2, m2] = (v('evFin').value || '10:00').split(':').map(Number);
      const start = new Date(y, mo - 1, da, h1, m1);
      let end = new Date(y, mo - 1, da, h2, m2);
      if (end <= start) end = new Date(start.getTime() + 3600000);
      event.start = { dateTime: start.toISOString() };
      event.end = { dateTime: end.toISOString() };
    }

    const btn = document.getElementById('evSave');
    btn.disabled = true; btn.textContent = 'Enregistrement…';
    let res;
    try { res = await window.api.gcal.create(event); }
    catch (e) { res = { error: String(e.message || e) }; }
    btn.disabled = false; btn.textContent = 'Enregistrer dans Google Agenda';

    if (res && res.error) { CC.toast(res.error, 'err'); return; }
    CC.toast('Événement ajouté à Google Agenda ✓', 'ok');
    this._closeModal();
    // Se replacer sur le mois de l'événement créé, puis rafraîchir (met le cache à jour)
    this.cur = new Date(y, mo - 1, 1);
    this.render();
    if (CC.renderToday) CC.renderToday();
  },

  // ----- Mini date-picker maison -----
  _dpInit(valueKey) {
    this._dpValue = valueKey;
    const [y, m] = valueKey.split('-').map(Number);
    this._dpView = new Date(y, m - 1, 1);
    this._dpLabel();
  },
  _dpLabel() {
    const btn = document.getElementById('evDateBtn');
    if (!btn) return;
    const [y, m, d] = this._dpValue.split('-').map(Number);
    btn.textContent = cap(new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }));
  },
  _dpToggle(force) {
    const pop = document.getElementById('evDatePop');
    if (!pop) return;
    const open = (force !== undefined) ? force : pop.classList.contains('hidden');
    if (open) { this._dpRenderPop(); pop.classList.remove('hidden'); } else pop.classList.add('hidden');
  },
  _dpRenderPop() {
    const pop = document.getElementById('evDatePop');
    if (!pop) return;
    const m = this._dpView;
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const off = (first.getDay() + 6) % 7;
    const gs = new Date(m.getFullYear(), m.getMonth(), 1 - off);
    const todayKey = keyOf(new Date());
    let html = `<div class="dp-head">
      <button type="button" class="dp-nav" data-dp-nav="-1" title="Mois précédent">‹</button>
      <span class="dp-title">${cap(AG_MOIS[m.getMonth()])} ${m.getFullYear()}</span>
      <button type="button" class="dp-nav" data-dp-nav="1" title="Mois suivant">›</button>
    </div><div class="dp-grid">`;
    html += AG_JOURS.map((j) => `<span class="dp-hd">${j[0]}</span>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = new Date(gs.getFullYear(), gs.getMonth(), gs.getDate() + i);
      const key = keyOf(d);
      const cls = ['dp-day'];
      if (d.getMonth() !== m.getMonth()) cls.push('out');
      if (key === todayKey) cls.push('today');
      if (key === this._dpValue) cls.push('sel');
      html += `<button type="button" class="${cls.join(' ')}" data-dp-day="${key}">${d.getDate()}</button>`;
    }
    html += '</div>';
    pop.innerHTML = html;
  },

  _show(html) {
    const back = document.getElementById('agendaModal');
    const inner = document.getElementById('agendaModalBody');
    if (!back || !inner) return;
    inner.innerHTML = html;
    back.classList.remove('hidden');
  },

  _closeModal() {
    const back = document.getElementById('agendaModal');
    if (back) back.classList.add('hidden');
  }
};

function metaRow(ic, txt) { return `<div class="ev-meta"><span class="ev-ic">${ic}</span><span>${esc(txt)}</span></div>`; }
function keyOf(d) { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function monthKeyOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function heure(iso) { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function frDateTime(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return ''; return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
