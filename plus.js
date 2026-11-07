/* Musify+ add-on: live lyrics, queue manager, song radio, daily mixes, new releases,
   playlist descriptions, URL routing, loading skeletons, Wrapped Live.
   Must load AFTER app.js (it wraps functions defined there). Styles live in styles.css. */
(() => {
const $ = id => document.getElementById(id);
const enc = encodeURIComponent;
const app = document.querySelector(".app");

/* ---------- STATS (Wrapped + Daily Mix seeds) ---------- */
const S = safeGet("musify-stats", { secs: 0, plays: 0, tracks: {}, artists: {}, days: {}, since: Date.now() });
let lastCur = null, session = 0, counted = false;
const dayKey = () => new Date().toISOString().slice(0, 10);

/* Used by auth.js: loads the signed-in user's stats into S (S is private to this file). */
window.musifyStatsBridge = {
  get: () => S,
  replace: data => {
    Object.keys(S).forEach(k => delete S[k]);
    Object.assign(S, { secs: 0, plays: 0, tracks: {}, artists: {}, days: {}, since: Date.now() }, data || {});
    lastCur = null; session = 0; counted = false;
  },
  refresh: () => { if (currentPage === "wrapped") renderWrapped(); }
};

audio.addEventListener("timeupdate", () => {
  if (!currentTrack || audio.paused || audioMode === "none" || probing) return;
  const cur = audio.currentTime;
  if (lastCur !== null) {
    const d = cur - lastCur;
    if (d > 0 && d < 2) {
      const t = currentTrack;
      const r = S.tracks[t.trackId] || (S.tracks[t.trackId] = { title: t.title, artist: t.artist, artwork: t.artwork, artistId: t.artistId, album: t.album, trackId: t.trackId, secs: 0, plays: 0 });
      const a = S.artists[t.artist] || (S.artists[t.artist] = { secs: 0, plays: 0 });
      S.secs += d; r.secs += d; a.secs += d; S.days[dayKey()] = (S.days[dayKey()] || 0) + d;
      session += d;
      if (!counted && session >= 15) { counted = true; S.plays++; r.plays++; a.plays++; if (window.musifyOnPlay) window.musifyOnPlay(t); }
    }
  }
  lastCur = cur;
  syncLyrics();
});
setInterval(() => safeSet("musify-stats", S), 10000);
addEventListener("pagehide", () => safeSet("musify-stats", S));

/* ---------- SIMILAR MUSIC / SONG RADIO ---------- */
const simCache = {};
async function similar(track) {
  if (simCache[track.trackId]) return simCache[track.trackId];
  const out = []; let genre = "";
  try {
    if (track.artistId) {
      const d = await fetchJson(`https://itunes.apple.com/lookup?id=${track.artistId}&entity=song&limit=15&country=US`);
      genre = (d.results.find(r => r.wrapperType === "artist") || {}).primaryGenreName || "";
      out.push(...d.results.filter(r => r.wrapperType === "track").map(normalizeAppleTrack));
    }
    if (genre) out.push(...(await searchApple(genre + " hits")).slice(0, 30));
  } catch {}
  const seen = new Set([track.trackId]);
  const list = out.filter(t => !seen.has(t.trackId) && seen.add(t.trackId))
    .sort(() => Math.random() - .5).slice(0, 30);
  return (simCache[track.trackId] = list);
}

async function startRadio(track, auto) {
  const list = await similar(track);
  if (currentTrack !== track) return;
  let q = auto ? currentQueue.slice() : [track];
  const have = new Set(q.map(x => x.trackId));
  const add = list.filter(x => !have.has(x.trackId));
  q.push(...add); q.__r = true;
  currentQueue = q;
  currentIndex = q.findIndex(x => x.trackId === track.trackId);
  $("previousButton").disabled = $("nextButton").disabled = q.length < 2;
  if (auto && add.length) playTrack(q[currentIndex + 1], q, currentIndex + 1);
}

const _rt = renderTracks;
renderTracks = (t, c) => { if (t) t.__radio = true; _rt(t, c); };

const _pt = playTrack;
playTrack = function (track, queue = currentQueue, index = -1) {
  const radio = queue && queue.__radio && !queue.__r;
  _pt(track, queue, index);
  lastCur = null; session = 0; counted = false;
  showTrack(track);
  if (radio) startRadio(track, false);
};

const _nt = nextTrack;
nextTrack = function () {
  if (!shuffleEnabled && !repeatEnabled && currentTrack && currentIndex >= currentQueue.length - 1) {
    startRadio(currentTrack, true); return;   /* playlist/queue ended: keep going with similar songs */
  }
  _nt();
};

/* ---------- RIGHT SIDEBAR + LIVE LYRICS ---------- */
const aside = document.createElement("aside");
aside.className = "rightbar";
aside.innerHTML = `<div class="rb-head">Now playing</div><div class="rb-cover" id="rbCover"><i class="fa-solid fa-music"></i></div>
<div class="rb-title" id="rbTitle">Nothing playing</div><div class="rb-artist" id="rbArtist"></div>
<div class="rb-lyrics"><div class="rb-lh"><b>Lyrics</b><button id="rbExpand" title="Expand lyrics"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button></div>
<div class="rb-lines" id="rbLines"><div class="ly-msg">Play a song to see lyrics.</div></div></div>`;
document.querySelector(".main").after(aside);
app.classList.add("has-right");

const lines = $("rbLines");
let lyr = [], active = -1;
const lyrCache = {};

function toggleLyrics() {
  const full = app.classList.toggle("lyr-full");
  $("rbExpand").innerHTML = `<i class="fa-solid fa-${full ? "down-left-and-up-right-to-center" : "up-right-and-down-left-from-center"}"></i>`;
  active = -1; syncLyrics();
}
$("rbExpand").onclick = toggleLyrics;

function showTrack(t) {
  $("rbTitle").textContent = t.title; $("rbArtist").textContent = t.artist;
  $("rbCover").innerHTML = t.artwork ? `<img src="${t.artwork}" alt="" referrerpolicy="no-referrer">` : '<i class="fa-solid fa-music"></i>';
  loadLyrics(t);
}

async function loadLyrics(t) {
  lyr = []; active = -1;
  lines.innerHTML = '<div class="ly-msg">Loading lyrics…</div>';
  let d = lyrCache[t.trackId];
  if (!d) {
    try {
      let r = await fetch(`https://lrclib.net/api/get?artist_name=${enc(t.artist)}&track_name=${enc(t.title)}&album_name=${enc(t.album)}&duration=${Math.round(t.duration)}`);
      if (r.ok) d = await r.json();
      else { const a = await (await fetch(`https://lrclib.net/api/search?q=${enc(t.artist + " " + t.title)}`)).json(); d = a.find(x => x.syncedLyrics) || a[0]; }
    } catch {}
    lyrCache[t.trackId] = d || {};
  }
  if (currentTrack !== t) return;
  lines.innerHTML = "";
  if (d && d.syncedLyrics) {
    lyr = d.syncedLyrics.split("\n").map(l => { const m = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)/); return m ? { t: +m[1] * 60 + +m[2], x: m[3].trim() || "♪" } : null; }).filter(Boolean);
    lyr.forEach(l => { const e = el("div", "ly", l.x); e.onclick = () => { if (audioMode === "full") audio.currentTime = l.t; }; lines.appendChild(e); });
  } else if (d && d.plainLyrics) {
    d.plainLyrics.split("\n").forEach(x => lines.appendChild(el("div", "ly", x)));
  } else lines.appendChild(el("div", "ly-msg", "No lyrics found for this song."));
}

function syncLyrics() {
  if (!lyr.length || audioMode !== "full") return;
  let i = -1; const c = audio.currentTime + .3;
  for (let k = 0; k < lyr.length && lyr[k].t <= c; k++) i = k;
  if (i === active) return;
  active = i;
  [...lines.children].forEach((e, k) => e.classList.toggle("on", k === i));
  const e = lines.children[i];
  if (e) lines.scrollTo({ top: e.offsetTop - lines.offsetTop - lines.clientHeight / 2 + e.clientHeight / 2 });
}

/* ---------- QUEUE MANAGEMENT ---------- */
function ownQueue() { if (!currentQueue.__own) { const q = currentQueue.slice(); q.__own = q.__r = true; currentQueue = q; } }
function queueAdd(track, next) {
  if (!currentTrack) { playTrack(track, [track], 0); return; }
  ownQueue();
  currentQueue.splice(next ? currentIndex + 1 : currentQueue.length, 0, { ...track });
  $("nextButton").disabled = false;
  showToast(next ? "Will play next" : "Added to queue");
}
function queueRender() {
  panelBody.innerHTML = "";
  if (!currentQueue.length) { panelBody.textContent = "Your queue is currently empty."; return; }
  const clear = el("button", "btn", "Clear queue");
  clear.onclick = () => { ownQueue(); currentQueue.splice(0, currentQueue.length, currentTrack); currentIndex = 0; $("nextButton").disabled = $("previousButton").disabled = true; queueRender(); };
  panelBody.appendChild(clear);
  currentQueue.forEach((t, i) => {
    const row = el("div", "q-row" + (i === currentIndex ? " current" : ""));
    const mid = el("div"); mid.appendChild(el("strong", "", t.title)); mid.appendChild(el("span", "", t.artist));
    mid.onclick = () => { playTrack(t, currentQueue, i); closePanel(); };
    row.appendChild(mid);
    const btn = (ic, fn, dis) => { const b = el("button", "row-btn"); b.innerHTML = `<i class="fa-solid fa-${ic}"></i>`; b.disabled = dis; b.onclick = fn; row.appendChild(b); };
    const move = d => { ownQueue(); const j = i + d, q = currentQueue; [q[i], q[j]] = [q[j], q[i]]; if (currentIndex === i) currentIndex = j; else if (currentIndex === j) currentIndex = i; queueRender(); };
    btn("chevron-up", () => move(-1), i === 0);
    btn("chevron-down", () => move(1), i === currentQueue.length - 1);
    btn("xmark", () => { ownQueue(); currentQueue.splice(i, 1); if (i <= currentIndex) currentIndex--; queueRender(); }, false);
    panelBody.appendChild(row);
  });
}
const _op = openPanel;
openPanel = function (type) {
  if (type === "lyrics") { toggleLyrics(); return; }
  _op(type);
  if (type === "queue") queueRender();
};
const _pick = openPicker;
openPicker = function (track) {
  _pick(track);
  [["forward", "Play next", true], ["list", "Add to queue", false]].forEach(([ic, label, next]) => {
    const row = el("div", "picker-item"); const s = el("span", "lbl");
    s.innerHTML = `<i class="fa-solid fa-${ic}"></i>`; s.appendChild(document.createTextNode(label));
    row.appendChild(s); row.onclick = () => { closeDialog(); queueAdd(track, next); };
    dialogBody.insertBefore(row, dialogBody.children[1]);
  });
};

/* ---------- SKELETONS ---------- */
const sk = n => Array.from({ length: n }, () => '<div class="track-card sk"><div class="track-art"></div><i></i><i style="width:50%"></i></div>').join("");
const _lt = loadTrending;
loadTrending = function () {
  $("trendingGrid").innerHTML = sk(10); $("exploreGrid").innerHTML = sk(10);
  return _lt().then(buildMixes);
};
const _st = searchTracks;
searchTracks = function (q) { $("searchResults").innerHTML = sk(10); return _st(q); };

/* ---------- NEW PAGES + NAV ---------- */
pages.push("releases", "wrapped", "developer");
const mk = (id, h, sub) => { const s = el("section", "page"); s.id = id; s.innerHTML = `<h1 class="page-heading">${h}</h1><p class="page-subtitle">${sub}</p>`; $("content").appendChild(s); return s; };
const rel = mk("releases", "New releases", "Recently released albums and singles.");
rel.insertAdjacentHTML("beforeend", '<div class="section"><div class="music-grid" id="relGrid"></div></div>');
const wr = mk("wrapped", "Musify Wrapped Live", "Your listening stats, updating as you listen.");
wr.insertAdjacentHTML("beforeend", '<div id="wrBody"></div>');
const menu = document.querySelector(".nav-section");
[["releases", "fa-record-vinyl", "New releases"], ["wrapped", "fa-chart-simple", "Wrapped"]].forEach(([p, ic, l]) => {
  const d = el("div", "nav-item"); d.dataset.page = p; d.innerHTML = `<i class="fa-solid ${ic}"></i> ${l}`; d.onclick = () => navigate(p); menu.appendChild(d);
});

/* home sections: daily mixes + new releases */
const home = $("home"), trendSec = home.querySelectorAll(".section")[1];
const mixSec = el("div", "section"); mixSec.innerHTML = '<div class="section-header"><h2>Made for you</h2></div><div class="music-grid" id="mixGrid"></div>';
home.insertBefore(mixSec, trendSec);
const relSec = el("div", "section"); relSec.innerHTML = '<div class="section-header"><h2>New releases</h2><button class="btn" onclick="navigate(\'releases\')">See all</button></div><div class="music-grid" id="homeRel"></div>';
home.appendChild(relSec);

function mixCard(grid, title, sub, art, tracks) {
  const c = el("div", "track-card");
  const a = el("div", "track-art"); if (art) { const i = document.createElement("img"); i.src = art; i.alt = ""; a.appendChild(i); setArtworkFallback(i); }
  c.appendChild(a); c.appendChild(el("h3", "", title)); c.appendChild(el("p", "", sub));
  c.onclick = () => { const q = tracks.slice(); q.__r = true; playTrack(q[0], q, 0); };
  grid.appendChild(c);
}

async function buildMixes() {
  const grid = $("mixGrid"), today = dayKey();
  let saved = safeGet("musify-mixes", null);
  if (!saved || saved.day !== today) {
    let seeds = Object.values(S.tracks).sort((a, b) => b.secs - a.secs).filter((t, i, a) => a.findIndex(x => x.artist === t.artist) === i);
    [...likedTracks, ...currentQueue].forEach(t => { if (!seeds.some(s => s.artist === t.artist)) seeds.push(t); });
    seeds = seeds.slice(0, 3);
    const mixes = [];
    for (const [i, s] of seeds.entries()) {
      const list = (await similar(s)).slice(0, 25);
      if (list.length) mixes.push({ name: "Daily Mix " + (i + 1), sub: [...new Set([s.artist, ...list.map(t => t.artist)])].slice(0, 3).join(", ") + " and more", tracks: list });
    }
    saved = { day: today, mixes }; safeSet("musify-mixes", saved);
  }
  grid.innerHTML = "";
  saved.mixes.forEach(m => mixCard(grid, m.name, m.sub, m.tracks[0] && m.tracks[0].artwork, m.tracks));
  mixSec.style.display = saved.mixes.length ? "" : "none";
}

let relLoaded = false;
async function loadReleases() {
  if (relLoaded) return; relLoaded = true;
  $("relGrid").innerHTML = $("homeRel").innerHTML = sk(10);
  try {
    const res = await Promise.all(["new music", "new single", "new album"].map(t =>
      fetchJson(`https://itunes.apple.com/search?term=${enc(t)}&entity=album&limit=100&country=US`).then(d => d.results || []).catch(() => [])));
    const seen = new Set(), now = Date.now();
    const albums = res.flat().filter(a => a.collectionId && !seen.has(a.collectionId) && seen.add(a.collectionId) && new Date(a.releaseDate) <= now)
      .sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate)).slice(0, 30);
    [["relGrid", albums], ["homeRel", albums.slice(0, 5)]].forEach(([id, list]) => {
      const g = $(id); g.innerHTML = "";
      list.forEach(a => {
        const c = el("div", "track-card"), art = el("div", "track-art"), u = bigArt(a.artworkUrl100);
        if (u) { const i = document.createElement("img"); i.src = u; i.alt = ""; art.appendChild(i); setArtworkFallback(i); }
        c.appendChild(art); c.appendChild(el("h3", "", a.collectionName));
        c.appendChild(el("p", "", `${a.trackCount === 1 || /- (Single|EP)/.test(a.collectionName) ? "Single" : "Album"} · ${a.artistName}`));
        c.onclick = () => openAlbum(a.collectionId, a.artistId); g.appendChild(c);
      });
    });
  } catch { relLoaded = false; $("relGrid").textContent = "Couldn't load new releases."; }
}

/* ---------- WRAPPED LIVE ---------- */
function renderWrapped() {
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1].secs - a[1].secs).slice(0, n);
  const hrs = (S.secs / 3600).toFixed(1), songs = Object.keys(S.tracks).length;
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10); return S.days[d] || 0; });
  const max = Math.max(...days, 1);
  const rank = list => list.map(([n, v], i) => `<div class="rank"><em>${i + 1}</em>${n.replace(/</g, "&lt;")}<span>${Math.round(v.secs / 60)} min</span></div>`).join("") || '<p class="page-subtitle">Nothing yet. Go play something.</p>';
  $("wrBody").innerHTML = `
  <div class="stat-grid"><div class="stat"><b>${hrs}</b><span>hours listened</span></div><div class="stat"><b>${S.plays}</b><span>plays</span></div>
  <div class="stat"><b>${songs}</b><span>different songs</span></div><div class="stat"><b>${Object.keys(S.artists).length}</b><span>artists</span></div></div>
  <div class="section"><div class="section-header"><h2>Last 14 days</h2></div><div class="bars">${days.map(v => `<div style="height:${Math.max(2, v / max * 100)}%" title="${Math.round(v / 60)} min"></div>`).join("")}</div></div>
  <div class="section"><div class="section-header"><h2>Top artists</h2></div>${rank(top(S.artists, 10))}</div>
  <div class="section"><div class="section-header"><h2>Top songs</h2></div>${rank(top(S.tracks, 10).map(([, t]) => [t.title + " · " + t.artist, t]))}</div>`;
}
setInterval(() => { if (currentPage === "wrapped") renderWrapped(); }, 2000);

/* ---------- PLAYLIST DESCRIPTIONS ---------- */
const _rpv = renderPlaylistView;
renderPlaylistView = function () {
  _rpv();
  const p = getPlaylist(currentPlaylistId), t = document.querySelector("#playlistView .pl-title");
  if (p && t && p.description) t.after(el("p", "pl-desc", p.description));
};
const _edd = editDetailsDialog;
editDetailsDialog = function (playlist) {
  _edd(playlist);
  const ta = el("textarea", "text-input"); ta.placeholder = "Add an optional description"; ta.maxLength = 200; ta.value = playlist.description || "";
  dialogBody.insertBefore(ta, dialogBody.querySelector(".panel-actions"));
  dialogBody.querySelector(".btn.primary").addEventListener("click", () => { playlist.description = ta.value.trim(); savePlaylists(); refreshLibraryViews(); });
};

/* ---------- URL ROUTING (/Musify/Home, /Musify/Playlist/<id>, /Musify/Artist/<id> ...) ----------
   GitHub Pages only has real files, so a refresh on /Musify/Home would normally 404. 404.html catches that
   and sends the visitor to /Musify/?p=/Home, and this code turns the address back into /Musify/Home. */
const NAMES = { home: "Home", search: "Search", explore: "Explore", library: "Library", settings: "Settings", releases: "New-Releases", wrapped: "Wrapped", playlist: "Playlist", artist: "Artist", album: "Album", developer: "Developer" };
const ROUTE_WORDS = Object.values(NAMES).map(n => n.toLowerCase());

/* BASE = everything in the address before the page name, e.g. "/Musify/" (or "/" when hosted at a domain root) */
const BASE = (() => {
  const parts = location.pathname.split("/");
  const at = parts.findIndex((p, i) => i > 0 && ROUTE_WORDS.includes(p.toLowerCase()));
  const base = at > 0 ? parts.slice(0, at) : parts.slice(0, -1);
  return base.join("/") + "/";
})();

const urlFor = (p, id) => BASE + NAMES[p] + (id ? "/" + id : "");
let routing = false;

const _nav = navigate;
navigate = function (page, id = null, save = true) {
  _nav(page, id, save);
  if (page === "wrapped") renderWrapped();
  if (page === "releases") loadReleases();
  if (save && !routing && currentPage === page && location.pathname !== urlFor(page, id)) try { history.pushState({ page, id }, "", urlFor(page, id)); } catch {}
};
const _gh = goToHistory;
goToHistory = function (i) { _gh(i); const e = pageHistory[i]; try { history.replaceState(null, "", urlFor(e.page, e.id)); } catch {} };

function routeFromUrl(initial) {
  const rest = location.pathname.slice(BASE.length).split("/").filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  let page = Object.keys(NAMES).find(k => NAMES[k].toLowerCase() === (rest[0] || "home").toLowerCase()) || "home";
  let id = rest[1] || null;
  if ((page === "artist" || page === "album") && !id) page = "home";
  if (page !== "playlist" && page !== "artist" && page !== "album") id = null;

  routing = true;
  navigate(page, id, !initial);
  routing = false;

  if (initial) {
    pageHistory = [{ page, id }];   /* so the Back button starts from the page you refreshed on */
    historyIndex = 0;
    updateNavigation();
    try { history.replaceState({ page, id }, "", urlFor(page, id)); } catch {}
  }
}

/* arrived from 404.html: ?p=/Home  ->  /Musify/Home */
const redirected = new URLSearchParams(location.search).get("p");
if (redirected) try {
  const clean = redirected.replace(/~and~/g, "&").replace(/^\/+/, "");
  history.replaceState(null, "", BASE + clean + location.hash);
} catch {}

addEventListener("popstate", () => routeFromUrl(false));
routeFromUrl(true);
loadReleases();
})();
