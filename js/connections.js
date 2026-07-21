'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Onglet Parametres : carte "Connexions & IA"
// (cle Gemini, identifiants Google, ton & signature des mails)
// ---------------------------------------------------------------------------
CC.connections = {
  async refreshStatus() {
    let st;
    try { st = await window.api.secrets.status(); } catch (_) { st = {}; }
    const gem = document.getElementById('connGeminiState');
    const goo = document.getElementById('connGoogleState');
    if (gem) { gem.textContent = st.geminiKey ? 'configuré ✓' : 'non configuré'; gem.classList.toggle('ok', !!st.geminiKey); }
    if (goo) { goo.textContent = st.googleConnected ? 'connecté ✓' : 'déconnecté'; goo.classList.toggle('ok', !!st.googleConnected); }
    const toll = document.getElementById('connTollState');
    if (toll) { toll.textContent = st.tollguruKey ? 'configuré ✓' : 'non configuré'; toll.classList.toggle('ok', !!st.tollguruKey); }
    CC._tollReady = !!st.tollguruKey;
    CC._geminiReady = !!st.geminiKey;
    CC._googleConnected = !!st.googleConnected;
    if (!st.available) CC.toast('Coffre du système indisponible : les clés ne peuvent pas être stockées en sécurité.', 'err');
  },

  render() {
    const s = CC.state.settings;
    const ton = document.getElementById('setMailTon');
    const sig = document.getElementById('setMailSignature');
    if (ton) ton.value = s.mailTon || 'cordial';
    if (sig) sig.value = s.mailSignature || '';
    const cv = document.getElementById('setCv');
    const tarif = document.getElementById('setTarifKm');
    if (cv) cv.value = String(s.chevauxFiscaux || 5);
    if (tarif) tarif.value = (s.tarifKm != null ? s.tarifKm : 0.636);
    const adr = document.getElementById('setAdresseDepart');
    if (adr) adr.value = s.adresseDepart || '';
    CC.connections.refreshStatus();
  },

  bind() {
    const $ = (id) => document.getElementById(id);

    // Liens externes
    $('lnkAiStudio') && $('lnkAiStudio').addEventListener('click', (e) => { e.preventDefault(); window.api.openUrl('https://aistudio.google.com/app/apikey'); });
    $('lnkGoogleHelp') && $('lnkGoogleHelp').addEventListener('click', (e) => { e.preventDefault(); window.api.openUrl('https://console.cloud.google.com/apis/credentials'); });

    // Gemini
    $('btnSaveGemini') && $('btnSaveGemini').addEventListener('click', async () => {
      const v = $('setGeminiKey').value.trim();
      if (!v) { CC.toast('Saisis une clé.', 'err'); return; }
      const r = await window.api.secrets.set('geminiKey', v);
      if (r.error) { CC.toast(r.error, 'err'); return; }
      $('setGeminiKey').value = '';
      CC.toast('Clé Gemini enregistrée.', 'ok');
      CC.connections.refreshStatus();
    });
    $('btnTestGemini') && $('btnTestGemini').addEventListener('click', async () => {
      CC.toast('Test en cours…');
      const r = await window.api.ai.test();
      if (r.error) {
        CC.toast('Échec du test IA.', 'err');
        await CC.dialog({
          type: 'error', title: 'Test Gemini échoué',
          message: 'Gemini n\'a pas répondu correctement.',
          detail: r.error + '\n\nVérifie que la clé vient bien de Google AI Studio (aistudio.google.com) et qu\'elle est enregistrée.'
        });
      } else {
        CC.toast('Gemini répond ✓' + (r.model ? ' (' + r.model + ')' : ''), 'ok');
      }
    });

    // Google : identifiants
    $('btnSaveGoogle') && $('btnSaveGoogle').addEventListener('click', async () => {
      const id = $('setGoogleClientId').value.trim();
      const sec = $('setGoogleClientSecret').value.trim();
      if (!id || !sec) { CC.toast('Renseigne le client ID et le secret.', 'err'); return; }
      const r1 = await window.api.secrets.set('googleClientId', id);
      const r2 = await window.api.secrets.set('googleClientSecret', sec);
      if (r1.error || r2.error) { CC.toast(r1.error || r2.error, 'err'); return; }
      $('setGoogleClientId').value = ''; $('setGoogleClientSecret').value = '';
      CC.toast('Identifiants Google enregistrés.', 'ok');
      CC.connections.refreshStatus();
    });

    // Google : connexion OAuth
    $('btnConnectGoogle') && $('btnConnectGoogle').addEventListener('click', async () => {
      // Enregistre d'abord ce qui est dans les champs (evite l'oubli du bouton "Enregistrer")
      const id = $('setGoogleClientId').value.trim();
      const sec = $('setGoogleClientSecret').value.trim();
      if (id) await window.api.secrets.set('googleClientId', id);
      if (sec) await window.api.secrets.set('googleClientSecret', sec);
      const st = await window.api.secrets.status();
      if (!st.googleClientId || !st.googleClientSecret) {
        await CC.dialog({ type: 'warning', title: 'Identifiants manquants', message: 'Renseigne le Client ID et le Client secret Google avant de connecter.' });
        return;
      }
      $('setGoogleClientId').value = ''; $('setGoogleClientSecret').value = '';
      CC.toast('Ouverture du navigateur pour autoriser Google…');
      const r = await window.api.gcal.connect();
      if (r.error) {
        CC.toast('Connexion échouée.', 'err');
        await CC.dialog({
          type: 'error',
          title: 'Connexion Google Agenda échouée',
          message: 'La connexion n\'a pas abouti.',
          detail: r.error + '\n\nLe plus simple : crée un identifiant OAuth de type « Application de bureau ».\n\nSi tu gardes un client « Application Web », ajoute cette URL exacte dans « URI de redirection autorisés » :\nhttp://127.0.0.1:42813\n\nVérifie aussi : API Google Calendar activée, et ton compte ajouté en « utilisateur test » sur l\'écran de consentement.'
        });
        return;
      }
      CC.toast('Google Agenda connecté ✓', 'ok');
      await CC.connections.refreshStatus();
      if (CC.renderToday) CC.renderToday();
      if (CC.notes) CC.notes.pull();   // récupère le pense-bête synchronisé
    });
    $('btnDisconnectGoogle') && $('btnDisconnectGoogle').addEventListener('click', async () => {
      await window.api.gcal.disconnect();
      CC.toast('Google Agenda déconnecté.', 'ok');
      await CC.connections.refreshStatus();
      if (CC.renderToday) CC.renderToday();
    });

    // TollGuru (péages)
    $('lnkTollGuru') && $('lnkTollGuru').addEventListener('click', (e) => { e.preventDefault(); window.api.openUrl('https://tollguru.com/developers/'); });
    $('btnSaveToll') && $('btnSaveToll').addEventListener('click', async () => {
      const v = $('setTollKey').value.trim();
      if (!v) { CC.toast('Saisis une clé.', 'err'); return; }
      const r = await window.api.secrets.set('tollguruKey', v);
      if (r.error) { CC.toast(r.error, 'err'); return; }
      $('setTollKey').value = '';
      CC.toast('Clé TollGuru enregistrée.', 'ok');
      CC.connections.refreshStatus();
    });

    // Frais kilométriques : CV (pré-remplit le tarif) + tarif au km
    $('setCv') && $('setCv').addEventListener('change', (e) => {
      const cv = parseInt(e.target.value, 10);
      CC.state.settings.chevauxFiscaux = cv;
      CC.state.settings.tarifKm = CC.baremeKm(cv);
      const tarif = $('setTarifKm'); if (tarif) tarif.value = CC.state.settings.tarifKm;
      CC.markDirty();
    });
    $('setTarifKm') && $('setTarifKm').addEventListener('change', (e) => {
      let v = parseFloat(e.target.value); if (isNaN(v) || v < 0) v = 0;
      CC.state.settings.tarifKm = v; CC.markDirty();
    });

    // Ton & signature -> settings
    $('setMailTon') && $('setMailTon').addEventListener('change', (e) => { CC.state.settings.mailTon = e.target.value; CC.markDirty(); });
    $('setMailSignature') && $('setMailSignature').addEventListener('change', (e) => { CC.state.settings.mailSignature = e.target.value; CC.markDirty(); });
    $('setAdresseDepart') && $('setAdresseDepart').addEventListener('change', (e) => { CC.state.settings.adresseDepart = e.target.value.trim(); CC.markDirty(); });
  }
};
