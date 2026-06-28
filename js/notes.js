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

  // Persiste : sur le web, sauvegarde silencieuse (IndexedDB + Drive) ;
  // sur le PC, on marque "à enregistrer" (sauvé au Ctrl+S, comme le reste).
  _persist() {
    if (CC.cloud) {
      clearTimeout(this._saveT);
      this._saveT = setTimeout(() => { try { CC.cloud.save(CC.storage.serialize()); } catch (_) {} }, 700);
    } else {
      CC.markDirty();
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
