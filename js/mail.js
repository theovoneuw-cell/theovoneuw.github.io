'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Page "Rédaction" : génération de mails assistée par IA (Gemini), autonome.
// Le texte généré est éditable et copiable.
// ---------------------------------------------------------------------------
CC.mailComposer = {
  // Applique le ton par defaut depuis les reglages (appele a l'ouverture de l'onglet)
  render() {
    const ton = document.getElementById('m_ton');
    if (ton && CC.state && CC.state.settings) ton.value = CC.state.settings.mailTon || 'cordial';
  },

  buildPrompt() {
    const type = document.getElementById('m_type').value;
    const ton = document.getElementById('m_ton').value;
    const client = document.getElementById('m_client').value.trim();
    const points = document.getElementById('m_points').value.trim();
    const sig = (CC.state.settings.mailSignature || '').trim();

    const tons = { pro: 'professionnel et neutre', cordial: 'cordial et chaleureux mais professionnel', ferme: 'ferme et direct, tout en restant courtois' };
    const types = {
      relance: 'une relance pour une facture impayée',
      remerciement: 'un mail de remerciement après réception d\'un paiement',
      devis: 'un mail de suivi d\'un devis envoyé',
      libre: 'un mail professionnel'
    };

    let p = `Rédige ${types[type] || types.libre} en français.\n`;
    p += `Ton : ${tons[ton] || tons.cordial}.\n`;
    if (client) p += `Destinataire / client : ${client}.\n`;
    if (points) p += `Éléments à intégrer : ${points}.\n`;
    p += `\nContraintes : commence par "Objet :" suivi d'un objet court, puis le corps du mail. `;
    p += `Sois concis (pas de blabla), va à l'essentiel, paragraphes courts. `;
    p += sig ? `Termine par cette signature exacte :\n${sig}` : `Termine par une formule de politesse simple (sans inventer de nom de société).`;
    return p;
  },

  async generate() {
    if (CC._geminiReady === false) {
      CC.toast('Configure d\'abord ta clé Gemini (Paramètres → Connexions & IA).', 'err');
      return;
    }
    const spin = document.getElementById('mailSpin');
    const btn = document.getElementById('btnGenerateMail');
    spin.classList.remove('hidden'); btn.disabled = true;
    try {
      const r = await window.api.ai.generate({
        model: CC.state.settings.aiModel || 'gemini-2.0-flash',
        system: 'Tu es l\'assistant d\'un micro-entrepreneur (prestations son et musique). Tu rédiges des mails clairs, polis et efficaces en français.',
        prompt: CC.mailComposer.buildPrompt(),
        temperature: 0.7
      });
      if (r.error) {
        CC.toast('Génération impossible.', 'err');
        await CC.dialog({ type: 'error', title: 'Génération IA échouée', message: 'Le mail n\'a pas pu être généré.', detail: r.error });
        return;
      }
      document.getElementById('m_result').value = r.text;
    } catch (e) {
      CC.toast('Erreur IA : ' + e.message, 'err');
    } finally {
      spin.classList.add('hidden'); btn.disabled = false;
    }
  },

  async copy() {
    const txt = document.getElementById('m_result').value;
    if (!txt) { CC.toast('Rien à copier.', 'err'); return; }
    try { await navigator.clipboard.writeText(txt); CC.toast('Mail copié dans le presse-papier.', 'ok'); }
    catch (_) { CC.toast('Copie impossible.', 'err'); }
  },

  bind() {
    document.getElementById('btnGenerateMail').addEventListener('click', () => CC.mailComposer.generate());
    document.getElementById('btnCopyMail').addEventListener('click', () => CC.mailComposer.copy());
  }
};
