'use strict';
// ---------------------------------------------------------------------------
// Thème clair / sombre. Chargé TÔT dans <head> (la CSP interdit l'inline) pour
// poser data-theme sur <html> AVANT le premier rendu → aucun flash.
// Préférence stockée en localStorage : 'light' | 'dark' | 'auto' (défaut auto,
// qui suit le réglage système). Bouton bascule dans l'en-tête (#btnTheme).
// ---------------------------------------------------------------------------
window.CC = window.CC || {};
(function () {
  var KEY = 'macompta:theme';
  var SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/></svg>';

  function stored() { try { return localStorage.getItem(KEY) || 'auto'; } catch (_) { return 'auto'; } }
  function systemDark() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  function resolve(pref) { return (pref === 'dark' || (pref === 'auto' && systemDark())) ? 'dark' : 'light'; }

  function updateBtn(eff) {
    var b = document.getElementById('btnTheme');
    if (!b) return;
    // On affiche l'icône de la cible : en clair -> lune (aller au sombre), inversement.
    b.innerHTML = eff === 'dark' ? SUN : MOON;
    b.title = eff === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre';
    b.setAttribute('aria-label', b.title);
  }

  function apply(pref) {
    var eff = resolve(pref);
    document.documentElement.setAttribute('data-theme', eff);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', eff === 'dark' ? '#14121f' : '#4f46e5');
    updateBtn(eff);
  }

  CC.theme = {
    get: stored,
    effective: function () { return resolve(stored()); },
    set: function (pref) { try { localStorage.setItem(KEY, pref); } catch (_) {} apply(pref); },
    toggle: function () { CC.theme.set(resolve(stored()) === 'dark' ? 'light' : 'dark'); },
    apply: function () { apply(stored()); }
  };

  // Appliqué immédiatement (avant le paint). Le bouton n'existe pas encore dans
  // le DOM → on resynchronise + on câble au DOMContentLoaded.
  apply(stored());
  document.addEventListener('DOMContentLoaded', function () {
    updateBtn(resolve(stored()));
    var b = document.getElementById('btnTheme');
    if (b) b.addEventListener('click', function () { CC.theme.toggle(); });
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
          if (stored() === 'auto') apply('auto');
        });
      } catch (_) {}
    }
  });
})();
