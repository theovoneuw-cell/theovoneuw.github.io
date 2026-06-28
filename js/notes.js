'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Pense-bête de l'accueil : petites tâches cochables. Stockées DANS le document
// de compta (CC.state.notes) → synchronisées PC ↔ iPhone via Google Drive.
// Une tâche cochée disparaît. Pensé pour les rappels rapides hors agenda.
// ---------------------------------------------------------------------------
const NOTES_KEY = 'accueilNotes';   // ancien stockage local (migration unique)

CC.notes = {
  _bound: false,
  _saveT: null,

  _items() {
    if (!Array.isArray(CC.state.notes)) CC.state.notes = [];
    return CC.state.notes;
  },

  // Persiste dans le fichier Drive dédié `notes.json` (PC et iPhone via la même
  // API window.api.notes). Indépendant de la compta -> pas d'écrasement croisé.
  // Débouncé pour ne pas écrire à chaque frappe.
  _persist() {
    clearTimeout(this._saveT);
    const snapshot = this._items().slice();
    this._saveT = setTimeout(() => {
      try { if (window.api && window.api.notes) window.api.notes.save(snapshot); } catch (_) {}
    }, 500);
  },

  // Récupère les notes depuis Drive et les affiche (appelé au démarrage et après
  // connexion Google). Si aucun fichier n'existe encore mais qu'on a des notes
  // locales (migration), on les y dépose.
  async pull() {
    if (!(window.api && window.api.notes)) return;
    let r;
    try { r = await window.api.notes.load(); } catch (_) { return; }
    if (!r) return;
    if (r.exists) {
      CC.state.notes = Array.isArray(r.notes) ? r.notes : [];
      this.render();
    } else {
      // Pas encore de fichier notes.json : on amorce avec d'éventuelles notes
      // migrées (ancien format) ou les notes locales, puis on crée le fichier.
      const seed = (CC.state._notesSeed && CC.state._notesSeed.length) ? CC.state._notesSeed : this._items();
      if (seed.length) { CC.state.notes = seed.slice(); this.render(); this._persist(); }
    }
  },

  bind() {
    if (this._bound) return;
    const input = document.getElementById('noteInput');
    if (!input) return;   // page d'accueil pas encore dans le DOM
    const addBtn = document.getElementById('noteAdd');

    const add = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      this._items().unshift({ id: CC.util.uid(), text: v.slice(0, 280) });
      this._persist();
      input.value = '';
      this.render();
      input.focus();
    };
    if (addBtn) addBtn.addEventListener('click', add);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

    const list = document.getElementById('todayNotesList');
    if (list) list.addEventListener('click', (e) => {
      const row = e.target.closest('.note-item[data-id]');
      if (row) this._done(row.dataset.id, row);
    });

    this._bound = true;
  },

  // Coche une tâche : petite animation « validée » puis retrait définitif.
  _done(id, row) {
    if (row.classList.contains('done')) return;
    row.classList.add('done');
    setTimeout(() => {
      CC.state.notes = this._items().filter((n) => n.id !== id);
      this._persist();
      this.render();
    }, 430);
  },

  render() {
    const list = document.getElementById('todayNotesList');
    if (!list) return;
    // Migration unique de l'ancien pense-bête local vers le document synchronisé.
    if (!this._migrated) {
      this._migrated = true;
      try {
        const raw = localStorage.getItem(NOTES_KEY);
        if (raw) {
          const old = JSON.parse(raw);
          if (Array.isArray(old) && old.length && !this._items().length) {
            CC.state.notes = old;
            this._persist();
          }
          localStorage.removeItem(NOTES_KEY);
        }
      } catch (_) {}
    }
    const items = this._items();
    const count = document.getElementById('noteCount');
    if (count) count.textContent = items.length ? String(items.length) : '';
    if (!items.length) {
      list.innerHTML = '<div class="note-empty">Rien en attente. Note une petite tâche ci-dessus.</div>';
      return;
    }
    list.innerHTML = items.map((n) => `
      <div class="note-item" data-id="${nEsc(n.id)}" title="Cocher comme fait">
        <span class="note-check" aria-hidden="true"></span>
        <span class="note-text">${nEsc(n.text)}</span>
      </div>`).join('');
  }
};

function nEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
