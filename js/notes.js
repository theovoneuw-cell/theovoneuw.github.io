'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Pense-bête de l'accueil : petites tâches cochables, stockées en local
// (localStorage, indépendant du fichier de compta). Une tâche cochée disparaît.
// Pensé pour les rappels rapides qui ne méritent pas une entrée d'agenda.
// ---------------------------------------------------------------------------
const NOTES_KEY = 'accueilNotes';

CC.notes = {
  _items: null,
  _bound: false,

  _load() {
    if (this._items) return this._items;
    try { this._items = JSON.parse(localStorage.getItem(NOTES_KEY)) || []; }
    catch (_) { this._items = []; }
    if (!Array.isArray(this._items)) this._items = [];
    return this._items;
  },
  _save() {
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(this._items || [])); } catch (_) {}
  },

  bind() {
    if (this._bound) return;
    const input = document.getElementById('noteInput');
    if (!input) return;   // page d'accueil pas encore dans le DOM
    const addBtn = document.getElementById('noteAdd');

    const add = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      this._load().unshift({ id: CC.util.uid(), text: v.slice(0, 280) });
      this._save();
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
      this._items = this._load().filter((n) => n.id !== id);
      this._save();
      this.render();
    }, 430);
  },

  render() {
    const list = document.getElementById('todayNotesList');
    if (!list) return;
    const items = this._load();
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
