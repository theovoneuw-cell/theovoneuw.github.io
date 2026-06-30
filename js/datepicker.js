'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Sélecteur de date maison RÉUTILISABLE (CC.dp), partagé par l'Agenda et les
// Factures pour une UI cohérente dans toute l'app.
//
// Markup attendu pour chaque champ :
//   <div class="dp" [data-dp-clearable] [data-dp-placeholder="—"]>
//     <button type="button" class="dp-field" data-dp-btn></button>
//     <input type="hidden" id="...">            <!-- porte la valeur YYYY-MM-DD -->
//     <div class="dp-pop hidden" data-dp-pop></div>
//   </div>
//
// La valeur vit dans l'<input> caché (les lectures `.value` existantes marchent).
// Toute sélection/effacement écrit l'input ET déclenche un event 'change' dessus
// (pour que les écouteurs existants réagissent). Le popup se repositionne tout
// seul pour ne JAMAIS être coupé par la modale (bascule à droite / vers le haut).
// ---------------------------------------------------------------------------
(function () {
  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const JOURS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  function key(d) { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  let outsideBound = false;

  CC.dp = {
    // Initialise tous les .dp d'un conteneur (ou tout le document si omis).
    init(root) {
      if (!outsideBound) {
        document.addEventListener('click', (e) => {
          if (!e.target.closest('.dp')) document.querySelectorAll('.dp-pop:not(.hidden)').forEach((p) => p.classList.add('hidden'));
        });
        outsideBound = true;
      }
      const scope = root || document;
      const wraps = (scope.matches && scope.matches('.dp')) ? [scope] : scope.querySelectorAll('.dp');
      wraps.forEach((w) => CC.dp._setup(w));
    },

    _setup(w) {
      if (!w._dpReady) {
        w._dpReady = true;
        w.addEventListener('click', (e) => {
          if (e.target.closest('[data-dp-btn]')) { CC.dp._toggle(w); return; }
          const nav = e.target.closest('[data-dp-nav]');
          if (nav) { const v = w._dpView; w._dpView = new Date(v.getFullYear(), v.getMonth() + parseInt(nav.dataset.dpNav, 10), 1); CC.dp._renderPop(w); CC.dp._place(w); return; }
          if (e.target.closest('[data-dp-clear]')) { CC.dp.set(w, ''); CC.dp._toggle(w, false); return; }
          const dd = e.target.closest('[data-dp-day]');
          if (dd) { CC.dp.set(w, dd.dataset.dpDay); CC.dp._toggle(w, false); }
        });
      }
      const dt = CC.dp._valueDate(w);
      w._dpView = dt ? new Date(dt.getFullYear(), dt.getMonth(), 1) : new Date();
      CC.dp._label(w);
    },

    // Récupère le wrap .dp à partir de l'id de son input.
    byInput(id) { const i = document.getElementById(id); return i ? i.closest('.dp') : null; },

    _input(w) { return w ? w.querySelector('input') : null; },
    _value(w) { const i = CC.dp._input(w); return i ? i.value : ''; },
    _valueDate(w) {
      const v = CC.dp._value(w);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
      const [y, m, d] = v.split('-').map(Number);
      return new Date(y, m - 1, d);
    },

    // Définit la valeur (YYYY-MM-DD ou '' pour vider) + met à jour l'UI + 'change'.
    set(w, value) {
      if (!w) return;
      const i = CC.dp._input(w);
      if (i) i.value = value || '';
      const dt = CC.dp._valueDate(w);
      if (dt) w._dpView = new Date(dt.getFullYear(), dt.getMonth(), 1);
      CC.dp._label(w);
      if (i) { try { i.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {} }
      if (typeof w._dpOnChange === 'function') { try { w._dpOnChange(value || ''); } catch (_) {} }
    },

    _label(w) {
      const btn = w.querySelector('[data-dp-btn]');
      if (!btn) return;
      const dt = CC.dp._valueDate(w);
      btn.textContent = dt
        ? cap(dt.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }))
        : (w.getAttribute('data-dp-placeholder') || 'Choisir une date');
      btn.classList.toggle('dp-empty', !dt);
    },

    _toggle(w, force) {
      const pop = w.querySelector('[data-dp-pop]');
      if (!pop) return;
      const open = (force !== undefined) ? force : pop.classList.contains('hidden');
      document.querySelectorAll('.dp-pop:not(.hidden)').forEach((p) => p.classList.add('hidden'));   // ferme les autres
      if (!open) { pop.classList.add('hidden'); return; }
      CC.dp._renderPop(w);
      pop.classList.remove('hidden');
      CC.dp._place(w);
    },

    // Repositionne le popup pour qu'il ne dépasse pas la modale (droite / bas).
    _place(w) {
      const pop = w.querySelector('[data-dp-pop]');
      if (!pop || pop.classList.contains('hidden')) return;
      pop.classList.remove('dp-pop-right', 'dp-pop-up');
      const cont = w.closest('.modal') || document.documentElement;
      const cr = cont.getBoundingClientRect();
      const r = pop.getBoundingClientRect();
      if (r.right > cr.right - 6) pop.classList.add('dp-pop-right');
      if (r.bottom > cr.bottom - 6) pop.classList.add('dp-pop-up');
    },

    _renderPop(w) {
      const pop = w.querySelector('[data-dp-pop]');
      if (!pop) return;
      const m = w._dpView || new Date();
      const selKey = CC.dp._value(w);
      const first = new Date(m.getFullYear(), m.getMonth(), 1);
      const off = (first.getDay() + 6) % 7;
      const gs = new Date(m.getFullYear(), m.getMonth(), 1 - off);
      const todayKey = key(new Date());
      let html = `<div class="dp-head">
        <button type="button" class="dp-nav" data-dp-nav="-1" title="Mois précédent">‹</button>
        <span class="dp-title">${cap(MOIS[m.getMonth()])} ${m.getFullYear()}</span>
        <button type="button" class="dp-nav" data-dp-nav="1" title="Mois suivant">›</button>
      </div><div class="dp-grid">`;
      html += JOURS.map((j) => `<span class="dp-hd">${j}</span>`).join('');
      for (let i = 0; i < 42; i++) {
        const d = new Date(gs.getFullYear(), gs.getMonth(), gs.getDate() + i);
        const k = key(d);
        const cls = ['dp-day'];
        if (d.getMonth() !== m.getMonth()) cls.push('out');
        if (k === todayKey) cls.push('today');
        if (k === selKey) cls.push('sel');
        html += `<button type="button" class="${cls.join(' ')}" data-dp-day="${k}">${d.getDate()}</button>`;
      }
      html += '</div>';
      if (w.hasAttribute('data-dp-clearable')) html += '<div class="dp-foot"><button type="button" class="lnk" data-dp-clear>Effacer la date</button></div>';
      pop.innerHTML = html;
    }
  };
})();
