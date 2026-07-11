'use strict';
window.CC = window.CC || {};

// ---------------------------------------------------------------------------
// Onglet Spotify (PC UNIQUEMENT) : télécommande complète du compte, look Spotify.
// Lecture "dans l'app" impossible (DRM Widevine absent d'Electron) → on pilote à
// distance l'appareil Spotify de l'utilisateur (app PC/téléphone/web player).
// L'API ne pilote qu'un appareil Spotify DÉJÀ OUVERT ; les commandes ciblent
// explicitement l'appareil (?device_id=) pour marcher même s'il n'est pas "actif".
//
// Fonctions : now-playing, play/pause/suivant/précédent, seek (barre cliquable),
// shuffle, repeat, like, volume, appareils, recherche, file d'attente, bibliothèque
// (colonne), vue playlist détaillée, densité d'affichage. Suggestions = top/recent/
// new-releases (recommandations & featured Spotify dépréciées → 403 apps récentes).
// Côté web (PWA) window.api.spotify est absent → bind() masque l'onglet.
// Uniquement des SVG, aucun emoji.
// ---------------------------------------------------------------------------
var SP_ICON = {
  play: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
  repeatOne: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="14.5" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">1</text></svg>',
  smallPlay: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'
};

CC.spotify = {
  _timer: null,
  _tickTimer: null,
  _connected: false,
  _playing: false,
  _deviceIds: '',
  _devices: [],
  _searchTimer: null,
  _browseLoaded: false,
  _lastPos: 0,
  _lastDur: 0,
  _lastAt: 0,
  _shuffle: false,
  _repeat: 'off',
  _currentId: '',
  _liked: false,
  _detailUri: '',

  async _api(method, path, body) {
    if (!window.api || !window.api.spotify) return { error: 'Indisponible.' };
    return await window.api.spotify.api({ method: method, path: path, body: body });
  },

  // Appareil ciblé : actif > sélectionné dans la liste > premier disponible.
  _targetDevice() {
    const list = CC.spotify._devices || [];
    const active = list.find((d) => d.is_active);
    if (active) return active.id;
    const sel = document.getElementById('spDevice');
    if (sel && sel.value && list.some((d) => d.id === sel.value)) return sel.value;
    return list[0] ? list[0].id : '';
  },
  _dev(path) {
    const id = CC.spotify._targetDevice();
    if (!id) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'device_id=' + id;
  },

  // ---- Connexion / déconnexion ----
  async connect() {
    CC.toast('Ouverture du navigateur pour autoriser Spotify…');
    const r = await window.api.spotify.connect();
    if (r && r.error) {
      CC.toast('Connexion Spotify échouée.', 'err');
      await CC.dialog({
        type: 'error', title: 'Connexion Spotify échouée',
        message: 'La connexion n\'a pas abouti.',
        detail: r.error + '\n\nVérifie que tu as créé une app sur developer.spotify.com, collé son Client ID, coché "Web API", et ajouté l\'URL de redirection :\nhttp://127.0.0.1:42815/callback'
      });
      return { ok: false };
    }
    CC.toast('Spotify connecté ✓', 'ok');
    CC.spotify._connected = true;
    CC.spotify._browseLoaded = false;
    if (CC.connections) CC.connections.refreshStatus();
    CC.spotify.render();
    return { ok: true };
  },
  async disconnect() {
    await window.api.spotify.disconnect();
    CC.spotify._connected = false;
    CC.spotify._browseLoaded = false;
    CC.spotify._currentId = '';
    CC.toast('Spotify déconnecté.', 'ok');
    if (CC.connections) CC.connections.refreshStatus();
    CC.spotify.render();
  },

  // ---- Rendu de l'onglet ----
  async render() {
    if (!window.api || !window.api.spotify) return;
    let st; try { st = await window.api.secrets.status(); } catch (_) { st = {}; }
    CC.spotify._connected = !!st.spotifyConnected;
    const nc = document.getElementById('spNotConnected');
    const co = document.getElementById('spConnected');
    if (nc) nc.classList.toggle('hidden', CC.spotify._connected);
    if (co) co.classList.toggle('hidden', !CC.spotify._connected);
    if (CC.spotify._connected) {
      CC.spotify._refresh();
      if (!CC.spotify._browseLoaded) CC.spotify._loadBrowse();
    }
  },

  // Enchaîne quelques relevés après une commande (Spotify est à la traîne ~1 s).
  _refreshSoon() { [300, 800, 1600].forEach((d) => setTimeout(() => CC.spotify._refresh(), d)); },

  async _refresh() {
    if (!CC.spotify._connected) return;
    const [player, devices] = await Promise.all([
      CC.spotify._api('GET', '/me/player'),
      CC.spotify._api('GET', '/me/player/devices')
    ]);
    CC.spotify._paintNow((player && !player.error && player.status !== 204) ? player.data : null);
    CC.spotify._paintDevices((devices && !devices.error && devices.data && devices.data.devices) || []);
  },

  _paintNow(state) {
    const art = document.getElementById('spArt');
    const title = document.getElementById('spTitle');
    const artist = document.getElementById('spArtist');
    const play = document.getElementById('spPlay');
    const vol = document.getElementById('spVol');
    const like = document.getElementById('spLike');
    if (!title) return;

    const item = state && state.item;
    CC.spotify._playing = !!(state && state.is_playing);
    if (play) play.innerHTML = CC.spotify._playing ? SP_ICON.pause : SP_ICON.play;

    // Shuffle / repeat
    CC.spotify._shuffle = !!(state && state.shuffle_state);
    CC.spotify._repeat = (state && state.repeat_state) || 'off';
    CC.spotify._paintToggles();

    if (!item) {
      if (art) { art.removeAttribute('src'); art.classList.add('sp-art-empty'); }
      title.textContent = 'Aucune lecture en cours';
      artist.textContent = 'Choisis une playlist, ou lance un morceau — la musique jouera sur ton appareil Spotify.';
      CC.spotify._lastDur = 0; CC.spotify._lastPos = 0;
      CC.spotify._setProgress(0, 0);
      if (like) like.classList.add('hidden');
      CC.spotify._currentId = '';
      return;
    }
    const imgs = (item.album && item.album.images) || [];
    const src = imgs.length ? (imgs[1] || imgs[0]).url : '';
    if (art && src) { art.src = src; art.classList.remove('sp-art-empty'); }
    title.textContent = item.name || '—';
    artist.textContent = (item.artists || []).map((a) => a.name).join(', ');
    const dur = item.duration_ms || 0;
    const pos = state.progress_ms || 0;
    CC.spotify._lastDur = dur; CC.spotify._lastPos = pos; CC.spotify._lastAt = Date.now();
    CC.spotify._setProgress(pos, dur);

    // Like : ne re-vérifier que si le titre a changé
    if (like) like.classList.remove('hidden');
    if (item.id && item.id !== CC.spotify._currentId) {
      CC.spotify._currentId = item.id;
      CC.spotify._refreshLike(item.id);
    }
  },

  _setProgress(pos, dur) {
    const bar = document.getElementById('spBar');
    const p = document.getElementById('spPos');
    const d = document.getElementById('spDur');
    if (bar) bar.style.width = dur ? Math.min(100, (pos / dur) * 100) + '%' : '0%';
    if (p) p.textContent = CC.spotify._fmt(pos);
    if (d) d.textContent = dur ? CC.spotify._fmt(dur) : '0:00';
  },

  _paintToggles() {
    const sh = document.getElementById('spShuffle');
    const rp = document.getElementById('spRepeat');
    if (sh) sh.classList.toggle('active', CC.spotify._shuffle);
    if (rp) {
      rp.classList.toggle('active', CC.spotify._repeat !== 'off');
      rp.innerHTML = CC.spotify._repeat === 'track' ? SP_ICON.repeatOne : SP_ICON.repeat;
    }
  },

  async _refreshLike(id) {
    const r = await CC.spotify._api('GET', '/me/tracks/contains?ids=' + id);
    const liked = !!(r && r.data && r.data[0]);
    if (CC.spotify._currentId === id) CC.spotify._setLikeUI(liked);
  },
  _setLikeUI(liked) {
    CC.spotify._liked = liked;
    const like = document.getElementById('spLike');
    if (like) {
      like.classList.toggle('liked', liked);
      like.title = liked ? 'Retirer des titres likés' : 'Ajouter aux titres likés';
    }
  },
  async _toggleLike() {
    const id = CC.spotify._currentId;
    if (!id) return;
    const want = !CC.spotify._liked;
    CC.spotify._setLikeUI(want);   // optimiste
    const r = await CC.spotify._api(want ? 'PUT' : 'DELETE', '/me/tracks?ids=' + id);
    if (r && r.error) { CC.spotify._setLikeUI(!want); CC.toast(r.error, 'err'); return; }
    CC.toast(want ? 'Ajouté à tes titres likés ✓' : 'Retiré des titres likés', 'ok');
  },

  _paintDevices(list) {
    CC.spotify._devices = list;
    const sel = document.getElementById('spDevice');
    const hint = document.getElementById('spNoDevice');
    if (hint) hint.classList.toggle('hidden', list.length > 0);
    if (!sel) return;
    const sig = list.map((d) => d.id).join('|');
    const activeId = (list.find((d) => d.is_active) || {}).id || '';
    if (sig !== CC.spotify._deviceIds) {
      CC.spotify._deviceIds = sig;
      sel.innerHTML = list.length
        ? '<option value="" disabled' + (activeId ? '' : ' selected') + '>Choisir un appareil…</option>' +
          list.map((d) => `<option value="${d.id}">${escSp(d.name)}${d.is_active ? ' • actif' : ''}</option>`).join('')
        : '<option value="">Aucun appareil</option>';
    }
    if (activeId && document.activeElement !== sel) sel.value = activeId;
  },

  _fmt(ms) {
    const s = Math.floor((ms || 0) / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  },

  // ---- Contrôles ----
  async _cmd(action) {
    let r;
    if (action === 'playpause') {
      const willPlay = !CC.spotify._playing;
      CC.spotify._setPlayingUI(willPlay);
      r = await CC.spotify._api('PUT', CC.spotify._dev(willPlay ? '/me/player/play' : '/me/player/pause'));
    } else if (action === 'next') r = await CC.spotify._api('POST', CC.spotify._dev('/me/player/next'));
    else if (action === 'prev') r = await CC.spotify._api('POST', CC.spotify._dev('/me/player/previous'));
    else if (action === 'shuffle') {
      CC.spotify._shuffle = !CC.spotify._shuffle; CC.spotify._paintToggles();
      r = await CC.spotify._api('PUT', CC.spotify._dev('/me/player/shuffle?state=' + CC.spotify._shuffle));
    } else if (action === 'repeat') {
      CC.spotify._repeat = CC.spotify._repeat === 'off' ? 'context' : (CC.spotify._repeat === 'context' ? 'track' : 'off');
      CC.spotify._paintToggles();
      r = await CC.spotify._api('PUT', CC.spotify._dev('/me/player/repeat?state=' + CC.spotify._repeat));
    }
    if (r && r.error) { CC.spotify._deviceToast(r.error); CC.spotify._refresh(); return; }
    if (action === 'next' || action === 'prev' || action === 'playpause') CC.spotify._refreshSoon();
  },

  _setPlayingUI(playing) {
    CC.spotify._playing = playing;
    CC.spotify._lastPos += Math.max(0, Date.now() - CC.spotify._lastAt);
    CC.spotify._lastAt = Date.now();
    const play = document.getElementById('spPlay');
    if (play) play.innerHTML = playing ? SP_ICON.pause : SP_ICON.play;
  },

  _tick() {
    if (!CC.spotify._playing || !CC.spotify._lastDur) return;
    const panel = document.getElementById('tab-spotify');
    if (!panel || !panel.classList.contains('active')) return;
    const pos = Math.min(CC.spotify._lastDur, CC.spotify._lastPos + (Date.now() - CC.spotify._lastAt));
    CC.spotify._setProgress(pos, CC.spotify._lastDur);
  },

  // Barre cliquable : aller à la position choisie
  async _seek(ev) {
    if (!CC.spotify._lastDur) return;
    const wrap = document.getElementById('spBarWrap');
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const pos = Math.floor(ratio * CC.spotify._lastDur);
    CC.spotify._lastPos = pos; CC.spotify._lastAt = Date.now();
    CC.spotify._setProgress(pos, CC.spotify._lastDur);
    const r = await CC.spotify._api('PUT', CC.spotify._dev('/me/player/seek?position_ms=' + pos));
    if (r && r.error) CC.spotify._deviceToast(r.error);
    else CC.spotify._refreshSoon();
  },

  async _setVolume(pct) {
    const r = await CC.spotify._api('PUT', CC.spotify._dev('/me/player/volume?volume_percent=' + Math.max(0, Math.min(100, parseInt(pct, 10) || 0))));
    if (r && r.error) CC.spotify._deviceToast(r.error);
  },

  async _transfer(deviceId) {
    if (!deviceId) return;
    const r = await CC.spotify._api('PUT', '/me/player', { device_ids: [deviceId], play: CC.spotify._playing });
    if (r && r.error) { CC.spotify._deviceToast(r.error); return; }
    CC.toast('Lecture transférée ✓', 'ok');
    CC.spotify._refreshSoon();
  },

  _deviceToast(err) {
    if (err === 'Aucun appareil Spotify actif.') CC.toast('Ouvre l\'app Spotify (PC/téléphone) puis clique sur « Actualiser ».', 'err');
    else CC.toast(err, 'err');
  },

  // ---- Lecture (playlist/album = context, titre = uri, + offset possible) ----
  async _play(opts) {
    const r = await CC.spotify._api('PUT', CC.spotify._dev('/me/player/play'), opts);
    if (r && r.error) { CC.spotify._deviceToast(r.error); return; }
    CC.toast('Lecture lancée ✓', 'ok');
    CC.spotify._refreshSoon();
  },

  // ---- Recherche ----
  async _search(q) {
    const box = document.getElementById('spResults');
    if (!box) return;
    q = (q || '').trim();
    if (!q) { CC.spotify._showView('browse'); box.innerHTML = ''; return; }
    CC.spotify._showView('search');
    const r = await CC.spotify._api('GET', '/search?type=track,playlist,album&limit=12&q=' + encodeURIComponent(q));
    if (r && r.error) { box.innerHTML = `<p class="sp-empty">${escSp(r.error)}</p>`; return; }
    const d = (r && r.data) || {};
    const cards = [];
    (d.tracks && d.tracks.items || []).forEach((t) => cards.push(CC.spotify._card({
      img: imgOf(t.album && t.album.images), title: t.name, sub: (t.artists || []).map((a) => a.name).join(', '), uri: t.uri
    })));
    (d.playlists && d.playlists.items || []).forEach((p) => p && cards.push(CC.spotify._card({
      img: imgOf(p.images), title: p.name, sub: 'Playlist', playlistId: p.id
    })));
    (d.albums && d.albums.items || []).forEach((a) => cards.push(CC.spotify._card({
      img: imgOf(a.images), title: a.name, sub: (a.artists || []).map((x) => x.name).join(', '), context: a.uri
    })));
    box.innerHTML = cards.length ? cards.join('') : '<p class="sp-empty">Aucun résultat.</p>';
  },

  // ---- Découverte + bibliothèque ----
  async _loadBrowse() {
    CC.spotify._browseLoaded = true;
    const [pl, recent, top, news] = await Promise.all([
      CC.spotify._api('GET', '/me/playlists?limit=40'),
      CC.spotify._api('GET', '/me/player/recently-played?limit=24'),
      CC.spotify._api('GET', '/me/top/tracks?limit=24&time_range=short_term'),
      CC.spotify._api('GET', '/browse/new-releases?limit=24&country=FR')
    ]);

    const playlists = ((pl && pl.data && pl.data.items) || []).filter(Boolean);
    CC.spotify._renderLibrary(playlists);
    CC.spotify._rail('spRailPlaylists', 'spPlaylists', playlists.map((p) => CC.spotify._card({
      img: imgOf(p.images), title: p.name, sub: (p.owner && p.owner.display_name) || 'Playlist', playlistId: p.id
    })));

    const seen = {};
    const recTracks = ((recent && recent.data && recent.data.items) || [])
      .map((i) => i.track).filter((t) => t && !seen[t.id] && (seen[t.id] = 1))
      .map((t) => CC.spotify._card({ img: imgOf(t.album && t.album.images), title: t.name, sub: (t.artists || []).map((a) => a.name).join(', '), uri: t.uri }));
    CC.spotify._rail('spRailRecent', 'spRecent', recTracks);

    CC.spotify._rail('spRailTop', 'spTop',
      ((top && top.data && top.data.items) || []).map((t) => CC.spotify._card({
        img: imgOf(t.album && t.album.images), title: t.name, sub: (t.artists || []).map((a) => a.name).join(', '), uri: t.uri
      })));

    CC.spotify._rail('spRailNew', 'spNew',
      ((news && news.data && news.data.albums && news.data.albums.items) || []).map((a) => CC.spotify._card({
        img: imgOf(a.images), title: a.name, sub: (a.artists || []).map((x) => x.name).join(', '), context: a.uri
      })));

    const anything = document.querySelector('#spBrowse .sp-rail:not(.hidden)');
    if (!anything) CC.spotify._browseLoaded = false;
  },

  _rail(railId, gridId, cards) {
    const rail = document.getElementById(railId);
    const grid = document.getElementById(gridId);
    if (!rail || !grid) return;
    if (cards && cards.length) { grid.innerHTML = cards.join(''); rail.classList.remove('hidden'); }
    else { grid.innerHTML = ''; rail.classList.add('hidden'); }
  },

  _renderLibrary(playlists) {
    const box = document.getElementById('spLibrary');
    if (!box) return;
    if (!playlists.length) { box.innerHTML = '<p class="sp-empty">Aucune playlist.</p>'; return; }
    box.innerHTML = playlists.map((p) => `<button class="sp-lib-item" data-playlist="${escSp(p.id)}" title="${escSp(p.name)}">
      <span class="sp-lib-art${imgOf(p.images) ? '' : ' sp-art-empty'}">${imgOf(p.images) ? `<img src="${escSp(imgOf(p.images))}" alt="" loading="lazy">` : ''}</span>
      <span class="sp-lib-meta"><span class="sp-lib-title">${escSp(p.name)}</span><span class="sp-lib-sub">Playlist · ${escSp((p.owner && p.owner.display_name) || '')}</span></span>
    </button>`).join('');
  },

  _card(o) {
    const attr = o.playlistId ? `data-playlist="${escSp(o.playlistId)}"`
      : (o.context ? `data-context="${escSp(o.context)}"` : (o.uri ? `data-uri="${escSp(o.uri)}"` : ''));
    const art = o.img ? `<img src="${escSp(o.img)}" alt="" loading="lazy">` : '';
    return `<button class="sp-card" ${attr} title="${escSp(o.title)}">
      <span class="sp-card-art${o.img ? '' : ' sp-art-empty'}">${art}<span class="sp-card-play">${SP_ICON.smallPlay}</span></span>
      <span class="sp-card-title">${escSp(o.title)}</span>
      <span class="sp-card-sub">${escSp(o.sub || '')}</span>
    </button>`;
  },

  // ---- Vue playlist détaillée ----
  async _openPlaylist(id) {
    const box = document.getElementById('spDetail');
    if (!box) return;
    CC.spotify._showView('detail');
    box.innerHTML = '<p class="sp-empty">Chargement…</p>';
    const r = await CC.spotify._api('GET', '/playlists/' + id + '?fields=name,uri,images,owner(display_name),tracks.items(track(name,uri,duration_ms,artists(name),album(images,name)))');
    if (r && r.error) { box.innerHTML = `<p class="sp-empty">${escSp(r.error)}</p>`; return; }
    const pl = (r && r.data) || {};
    CC.spotify._detailUri = pl.uri || '';
    const tracks = ((pl.tracks && pl.tracks.items) || []).map((i) => i.track).filter(Boolean);
    const cover = imgOf(pl.images);
    const rows = tracks.map((t, i) => `<button class="sp-trk" data-uri="${escSp(t.uri)}">
      <span class="sp-trk-n">${i + 1}</span>
      <span class="sp-trk-meta"><span class="sp-trk-title">${escSp(t.name)}</span><span class="sp-trk-artist">${escSp((t.artists || []).map((a) => a.name).join(', '))}</span></span>
      <span class="sp-trk-dur">${CC.spotify._fmt(t.duration_ms || 0)}</span>
    </button>`).join('');
    box.innerHTML = `<div class="sp-detail-head">
        <button class="sp-back" id="spBack"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg> Retour</button>
        <div class="sp-detail-hero">
          <span class="sp-detail-art${cover ? '' : ' sp-art-empty'}">${cover ? `<img src="${escSp(cover)}" alt="">` : ''}</span>
          <div class="sp-detail-info">
            <div class="sp-detail-kind">Playlist</div>
            <div class="sp-detail-title">${escSp(pl.name || '')}</div>
            <div class="sp-detail-sub">${escSp((pl.owner && pl.owner.display_name) || '')} · ${tracks.length} titres</div>
            <button class="sp-detail-play" id="spDetailPlay"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg> Lecture</button>
          </div>
        </div>
      </div>
      <div class="sp-tracklist">${rows || '<p class="sp-empty">Playlist vide.</p>'}</div>`;
  },

  _showView(name) {
    const browse = document.getElementById('spBrowse');
    const results = document.getElementById('spResults');
    const detail = document.getElementById('spDetail');
    if (browse) browse.classList.toggle('hidden', name !== 'browse');
    if (results) results.classList.toggle('hidden', name !== 'search');
    if (detail) detail.classList.toggle('hidden', name !== 'detail');
  },

  // ---- File d'attente ----
  async _toggleQueue() {
    const q = document.getElementById('spQueue');
    if (!q) return;
    const show = q.classList.contains('hidden');
    q.classList.toggle('hidden', !show);
    if (show) CC.spotify._loadQueue();
  },
  async _loadQueue() {
    const list = document.getElementById('spQueueList');
    if (!list) return;
    list.innerHTML = '<p class="sp-empty">Chargement…</p>';
    const r = await CC.spotify._api('GET', '/me/player/queue');
    if (r && r.error) { list.innerHTML = `<p class="sp-empty">${escSp(r.error)}</p>`; return; }
    const q = (r && r.data && r.data.queue) || [];
    if (!q.length) { list.innerHTML = '<p class="sp-empty">File d\'attente vide.</p>'; return; }
    list.innerHTML = q.slice(0, 30).map((t, i) => `<div class="sp-trk sp-trk-static">
      <span class="sp-trk-n">${i + 1}</span>
      <span class="sp-trk-meta"><span class="sp-trk-title">${escSp(t.name || '')}</span><span class="sp-trk-artist">${escSp((t.artists || []).map((a) => a.name).join(', '))}</span></span>
      <span class="sp-trk-dur">${CC.spotify._fmt(t.duration_ms || 0)}</span>
    </div>`).join('');
  },

  // ---- Densité d'affichage ----
  _setDensity(v) {
    const w = { s: '128px', m: '158px', l: '192px' }[v] || '158px';
    const app = document.querySelector('.sp-app');
    if (app) app.style.setProperty('--sp-card-w', w);
    try { localStorage.setItem('sp:density', v); } catch (_) {}
  },

  // ---- Câblage ----
  bind() {
    if (!window.api || !window.api.spotify) {
      const btn = document.querySelector('.tab[data-tab="spotify"]');
      if (btn) btn.classList.add('hidden');
      const sec = document.getElementById('tab-spotify');
      if (sec) sec.remove();
      const conn = document.getElementById('spSettingsBlock');
      if (conn) conn.classList.add('hidden');
      return;
    }

    const sec = document.getElementById('tab-spotify');
    if (!sec) return;

    const cbtn = document.getElementById('spConnect');
    if (cbtn) cbtn.addEventListener('click', () => CC.spotify.connect());

    // Délégation des clics
    sec.addEventListener('click', (e) => {
      const cmd = e.target.closest('[data-sp]');
      if (cmd) { CC.spotify._cmd(cmd.dataset.sp); return; }
      if (e.target.closest('#spLike')) { CC.spotify._toggleLike(); return; }
      if (e.target.closest('#spDevRefresh')) { CC.spotify._refresh(); CC.spotify._browseLoaded = false; CC.spotify._loadBrowse(); return; }
      if (e.target.closest('#spQueueBtn')) { CC.spotify._toggleQueue(); return; }
      if (e.target.closest('#spQueueClose')) { const q = document.getElementById('spQueue'); if (q) q.classList.add('hidden'); return; }
      if (e.target.closest('#spBack')) { CC.spotify._showView('browse'); return; }
      if (e.target.closest('#spDetailPlay')) { if (CC.spotify._detailUri) CC.spotify._play({ context_uri: CC.spotify._detailUri }); return; }

      const trk = e.target.closest('.sp-trk[data-uri]');
      if (trk) {
        if (CC.spotify._detailUri) CC.spotify._play({ context_uri: CC.spotify._detailUri, offset: { uri: trk.dataset.uri } });
        else CC.spotify._play({ uris: [trk.dataset.uri] });
        return;
      }
      const libItem = e.target.closest('.sp-lib-item');
      if (libItem) { CC.spotify._openPlaylist(libItem.dataset.playlist); return; }
      const card = e.target.closest('.sp-card');
      if (card) {
        if (card.dataset.playlist) CC.spotify._openPlaylist(card.dataset.playlist);
        else if (card.dataset.context) CC.spotify._play({ context_uri: card.dataset.context });
        else if (card.dataset.uri) CC.spotify._play({ uris: [card.dataset.uri] });
        return;
      }
    });

    // Barre de lecture cliquable (seek)
    const barWrap = document.getElementById('spBarWrap');
    if (barWrap) barWrap.addEventListener('click', (e) => CC.spotify._seek(e));

    const vol = document.getElementById('spVol');
    if (vol) vol.addEventListener('change', (e) => CC.spotify._setVolume(e.target.value));
    const dev = document.getElementById('spDevice');
    if (dev) dev.addEventListener('change', (e) => CC.spotify._transfer(e.target.value));

    const dens = document.getElementById('spDensity');
    if (dens) {
      let pref = 'm'; try { pref = localStorage.getItem('sp:density') || 'm'; } catch (_) {}
      dens.value = pref; CC.spotify._setDensity(pref);
      dens.addEventListener('change', (e) => CC.spotify._setDensity(e.target.value));
    }

    const search = document.getElementById('spSearch');
    if (search) {
      search.addEventListener('input', (e) => {
        clearTimeout(CC.spotify._searchTimer);
        const q = e.target.value;
        CC.spotify._searchTimer = setTimeout(() => CC.spotify._search(q), 350);
      });
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(CC.spotify._searchTimer); CC.spotify._search(search.value); }
      });
    }

    CC.spotify._timer = setInterval(() => {
      const panel = document.getElementById('tab-spotify');
      if (panel && panel.classList.contains('active') && CC.spotify._connected) CC.spotify._refresh();
    }, 4000);
    CC.spotify._tickTimer = setInterval(() => CC.spotify._tick(), 500);
  }
};

function escSp(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function imgOf(images) { return (images && images.length) ? images[Math.min(1, images.length - 1)].url : ''; }
