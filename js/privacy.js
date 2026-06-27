'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Mode discret : masque tous les montants € et pourcentages (•••) pour pouvoir
// ouvrir l'app entouré de monde. Un code PIN (facultatif) révèle les chiffres.
// Les outils (agenda, trajets, mails, rédaction) restent utilisables masqués.
// ---------------------------------------------------------------------------

const EYE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// Bascule l'affichage et re-render toutes les vues numériques.
CC.applyPrivacy = function (on) {
  CC.state.privacy = !!on;
  document.body.classList.toggle('privacy', !!on);
  CC.privacy.syncButton();
  if (CC.render) CC.render();                 // dashboard + factures + fiscal
  if (CC.renderBilan) CC.renderBilan();
  if (CC.renderToday) CC.renderToday();
  if (CC.trajets) { CC.trajets.renderList(); CC.trajets.renderRate(); }
};

CC.privacy = {
  // Met à jour l'icône / l'état du bouton œil de la barre supérieure.
  syncButton() {
    const btn = document.getElementById('btnPrivacy');
    if (!btn) return;
    const masked = !!CC.state.privacy;
    btn.classList.toggle('on', masked);
    btn.title = masked ? 'Afficher les chiffres' : 'Masquer les chiffres';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = masked ? EYE_OFF : EYE;
  },

  // Clic sur l'œil : masquer = immédiat ; afficher = code requis si défini.
  async toggleFromButton() {
    if (CC.state.privacy) {
      let st; try { st = await window.api.privacy.status(); } catch (_) { st = {}; }
      if (st && st.hasPin) {
        const r = await CC.dialog({
          type: 'question',
          title: 'Code de confidentialité',
          message: 'Saisis ton code pour afficher les chiffres.',
          input: { type: 'password', placeholder: 'Code' },
          buttons: ['Annuler', 'Afficher'], defaultId: 1, cancelId: 0
        });
        if (!r || r.response !== 1) return;
        let v; try { v = await window.api.privacy.verify(r.value || ''); } catch (_) { v = {}; }
        if (!v || !v.verified) { CC.toast('Code incorrect.', 'err'); return; }
      }
      CC.applyPrivacy(false);
    } else {
      CC.applyPrivacy(true);
    }
  },

  // Statut de la carte "Mode discret" (pastille + case "démarrer masqué").
  async refreshStatus() {
    let st; try { st = await window.api.privacy.status(); } catch (_) { st = {}; }
    const pill = document.getElementById('privPinState');
    if (pill) { pill.textContent = st.hasPin ? 'code défini ✓' : 'aucun code'; pill.classList.toggle('ok', !!st.hasPin); }
    const startup = document.getElementById('privStartup');
    if (startup) startup.checked = !!st.startup;
  },

  bind() {
    const btn = document.getElementById('btnPrivacy');
    if (btn) btn.addEventListener('click', () => CC.privacy.toggleFromButton());

    const startup = document.getElementById('privStartup');
    if (startup) startup.addEventListener('change', async (e) => {
      await window.api.privacy.setStartup(e.target.checked);
      CC.toast(e.target.checked ? 'L\'app démarrera en mode discret.' : 'Démarrage normal rétabli.', 'ok');
    });

    const setBtn = document.getElementById('btnPrivSetPin');
    if (setBtn) setBtn.addEventListener('click', async () => {
      if (CC.state.privacy) { CC.toast('Affiche d\'abord les chiffres pour gérer le code.', 'err'); return; }
      const el = document.getElementById('privPin');
      const r = await window.api.privacy.setPin((el.value || '').trim());
      if (r.error) { CC.toast(r.error, 'err'); return; }
      el.value = '';
      CC.toast('Code enregistré.', 'ok');
      CC.privacy.refreshStatus();
    });

    const clr = document.getElementById('btnPrivClearPin');
    if (clr) clr.addEventListener('click', async () => {
      if (CC.state.privacy) { CC.toast('Affiche d\'abord les chiffres pour gérer le code.', 'err'); return; }
      await window.api.privacy.clearPin();
      CC.toast('Code supprimé.', 'ok');
      CC.privacy.refreshStatus();
    });
  },

  // Après chargement initial : aligne l'icône et le statut de la carte.
  afterLoad() {
    CC.privacy.syncButton();
    CC.privacy.refreshStatus();
  }
};
