/* Musify core: storage, search, playlists, profiles, streaming, player controls. */
const audio = document.getElementById("audioPlayer");

let currentTrack = null;
let currentQueue = [];
let currentIndex = -1;
let shuffleEnabled = false;
let repeatEnabled = false;
let volume = 100;

const LIKED_ID = "liked";
let pageHistory = [{ page: "home", id: null }];
let historyIndex = 0;
let currentPage = "home";
let currentPlaylistId = null;
let currentEntityId = null;      /* artist id or album id when on those pages */
let renderedEntity = "";

/* ---------- COOKIE CONSENT + STORAGE ----------
   A cookie remembers the consent choice. The library itself (playlists,
   liked songs, covers) lives in localStorage, and is only written there
   after the user has accepted. */

const CONSENT_KEY = "musify-consent";

function getCookie(name) {
    const match = document.cookie.split("; ").find(row => row.startsWith(name + "="));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

function setCookie(name, value, days) {
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${days * 86400}; path=/; SameSite=Lax`;
}

function readConsent() {
    const cookie = getCookie(CONSENT_KEY);
    if (cookie === "accepted" || cookie === "declined") return cookie;

    /* Some browsers refuse cookies on local files; fall back to storage for the choice only. */
    try {
        const stored = localStorage.getItem(CONSENT_KEY);
        if (stored === "accepted" || stored === "declined") return stored;
    } catch {}

    return null;
}

let consent = readConsent();   /* "accepted" | "declined" | null (not chosen yet) */

function canPersist() { return consent === "accepted"; }

function loadSaved(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(value) ? value : [];
    } catch { return []; }
}

function safeGet(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value === null || value === undefined ? fallback : value;
    } catch { return fallback; }
}

/* Writes only happen after the user accepted. Returns false if a write was attempted and failed. */
function safeSet(key, value) {
    if (!canPersist()) return true;
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
}

/* the old "Recently Played" list is gone, so remove its saved data */
try { localStorage.removeItem("musify-history"); } catch {}

let likedTracks = loadSaved("musify-liked");
let playlists = loadSaved("musify-playlists").filter(
    p => p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.tracks)
);
let displayName = safeGet("musify-name", "skiddlez23");

function saveLibrary() {
    safeSet("musify-liked", likedTracks);
    safeSet("musify-playlists", playlists);
    safeSet("musify-name", displayName);
}

function clearStoredData() {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith("musify-") && key !== CONSENT_KEY) keys.push(key);
        }
        keys.forEach(key => localStorage.removeItem(key));
    } catch {}
}

function setConsent(choice) {
    consent = choice;
    setCookie(CONSENT_KEY, choice, 365);

    if (getCookie(CONSENT_KEY) !== choice) {
        try { localStorage.setItem(CONSENT_KEY, choice); } catch {}
    }

    if (choice === "accepted") saveLibrary();
    else clearStoredData();

    document.getElementById("cookieBanner").classList.remove("show");
    updateCookieStatus();
}

function updateCookieStatus() {
    const text = consent === "accepted"
        ? "Saving is on. Playlists, covers and liked songs are kept on this device."
        : consent === "declined"
            ? "Saving is off. Your library only lasts until you refresh the page."
            : "No choice made yet.";
    document.getElementById("cookieStatus").textContent = text;
}

document.getElementById("cookieAccept").onclick = () => { setConsent("accepted"); showToast("Saving turned on"); };
document.getElementById("cookieDecline").onclick = () => { setConsent("declined"); showToast("Saving turned off"); };

let searchTimer = null;
let searchRequest = 0;
let trendingRequest = 0;

audio.volume = 1;

/* ---------- SMALL UI HELPERS ---------- */

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

let toastTimer = null;
function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

/* ---------- BROWSER TAB TITLE ---------- */

function setTitle(track) {
    document.title = track
        ? `Musify - "${track.title}" by "${getArtist(track)}"`
        : "Musify";
}

/* ---------- APPLE MUSIC DATA ---------- */

async function fetchJson(url, signal) {
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
}

const APPLE_TRENDING_URL =
    "https://rss.applemarketingtools.com/api/v2/us/music/most-played/50/songs.json";

async function fetchAppleTrending() {
    const sources = [
        async () => {
            const data = await fetchJson(APPLE_TRENDING_URL);
            return (data.feed?.results || []).map(item => item.id);
        },
        async () => {
            const data = await fetchJson("https://itunes.apple.com/us/rss/topsongs/limit=50/json");
            return (data.feed?.entry || []).map(entry => entry.id?.attributes?.["im:id"]);
        }
    ];

    for (const getIds of sources) {
        try {
            const ids = (await getIds()).filter(Boolean);
            if (!ids.length) continue;

            const data = await fetchJson(
                `https://itunes.apple.com/lookup?id=${ids.join(",")}&country=US`
            );

            const byId = {};
            (data.results || [])
                .filter(item => item.wrapperType === "track")
                .forEach(item => { byId[item.trackId] = item; });

            const tracks = ids.map(id => byId[id]).filter(Boolean).map(normalizeAppleTrack);
            if (tracks.length) return tracks;
        } catch (error) {
            console.warn("Chart source failed:", error);
        }
    }

    const data = await fetchJson(
        "https://itunes.apple.com/search?term=top+hits&entity=song&limit=50&country=US"
    );
    return (data.results || [])
        .filter(item => item.wrapperType === "track")
        .map(normalizeAppleTrack);
}

async function searchApple(query) {
    const data = await fetchJson(
        `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=50&country=US`
    );
    return (data.results || [])
        .filter(item => item.wrapperType === "track")
        .map(normalizeAppleTrack);
}

async function searchArtists(query) {
    const data = await fetchJson(
        `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=musicArtist&limit=6&country=US`
    );
    return (data.results || []).filter(item => item.artistId);
}

function normalizeAppleTrack(item) {
    let artwork = item.artworkUrl100 || item.artworkUrl60 || "";
    if (artwork) {
        artwork = artwork
            .replace(/\/\d+x\d+bb\./, "/600x600bb.")
            .replace(/\/\d+x\d+bb(?=\/)/, "/600x600bb")
            .replace("http://", "https://");
    }
    return {
        trackId: String(item.trackId),
        title: item.trackName || "Untitled",
        artist: item.artistName || "Unknown artist",
        album: item.collectionName || "Unknown album",
        artwork,
        previewUrl: item.previewUrl || item.previewURL || "",
        duration: item.trackTimeMillis ? item.trackTimeMillis / 1000 : 0,
        hasDuration: Boolean(item.trackTimeMillis),
        albumId: item.collectionId || null,
        artistId: item.artistId || null
    };
}

function setArtworkFallback(img) {
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
        const placeholder = document.createElement("div");
        placeholder.className = "track-art-placeholder";
        placeholder.innerHTML = '<i class="fa-solid fa-music"></i>';
        const parent = img.parentElement;
        if (parent) { img.remove(); parent.appendChild(placeholder); }
    };
}

/* ---------- NAVIGATION ---------- */

const pages = ["home","search","explore","library","playlist","settings","artist","album"];
const contentEl = document.getElementById("content");

function scrollTop() {
    try { contentEl.scrollTo({ top: 0, behavior: "instant" }); } catch { contentEl.scrollTop = 0; }
}

function updateNavigation() {
    document.querySelectorAll(".page").forEach(page => {
        page.classList.toggle("active", page.id === currentPage);
    });

    const sidebarPage = ["playlist", "artist", "album"].includes(currentPage) ? null : currentPage;
    document.querySelectorAll(".nav-item[data-page]").forEach(item => {
        item.classList.toggle("active", item.dataset.page === sidebarPage);
    });

    const mobilePage = currentPage === "playlist" ? "library"
        : (currentPage === "artist" || currentPage === "album") ? "search" : currentPage;
    document.querySelectorAll("#mobileNav button").forEach(item => {
        item.classList.toggle("active", item.dataset.page === mobilePage);
    });

    document.getElementById("backButton").disabled = historyIndex <= 0;
    document.getElementById("forwardButton").disabled = historyIndex >= pageHistory.length - 1;

    refreshLibraryViews();
    renderEntityPage();
}

/* artist + album pages are drawn when you arrive on them (or when you move to a different one) */
function renderEntityPage() {
    if (currentPage !== "artist" && currentPage !== "album") return;

    const key = currentPage + ":" + currentEntityId;
    if (key === renderedEntity) return;
    renderedEntity = key;

    if (currentPage === "artist") renderArtistPage(currentEntityId);
    else renderAlbumPage(currentEntityId);
}

function navigate(page, id = null, saveHistory = true) {
    if (!pages.includes(page)) return;
    if ((page === "artist" || page === "album") && !id) return;

    const sameEntity = page === "playlist" ? id === currentPlaylistId
        : (page === "artist" || page === "album") ? id === currentEntityId : true;
    if (saveHistory && page === currentPage && sameEntity) return;

    currentPage = page;
    if (page === "playlist") currentPlaylistId = id;
    if (page === "artist" || page === "album") currentEntityId = id;

    if (saveHistory) {
        pageHistory = pageHistory.slice(0, historyIndex + 1);
        pageHistory.push({ page, id });
        historyIndex = pageHistory.length - 1;
    }

    updateNavigation();
    scrollTop();
}

function goToHistory(index) {
    historyIndex = index;
    const entry = pageHistory[historyIndex];
    currentPage = entry.page;
    if (entry.page === "playlist") currentPlaylistId = entry.id;
    if (entry.page === "artist" || entry.page === "album") currentEntityId = entry.id;
    updateNavigation();
    scrollTop();
}

document.getElementById("backButton").onclick = () => { if (historyIndex > 0) goToHistory(historyIndex - 1); };
document.getElementById("forwardButton").onclick = () => { if (historyIndex < pageHistory.length - 1) goToHistory(historyIndex + 1); };

/* ---------- TRENDING ---------- */

async function loadTrending() {
    const grid = document.getElementById("trendingGrid");
    const message = document.getElementById("trendingMessage");
    const request = ++trendingRequest;

    grid.innerHTML = "";
    message.textContent = "Loading popular music...";

    try {
        const tracks = await fetchAppleTrending();
        if (request !== trendingRequest) return;

        currentQueue = tracks;
        currentIndex = -1;

        renderTracks(tracks, grid);

        const exploreGrid = document.getElementById("exploreGrid");
        exploreGrid.innerHTML = "";
        renderTracks(tracks, exploreGrid);

        message.textContent = tracks.length ? "" : "No songs were found.";
    } catch (error) {
        if (request !== trendingRequest) return;
        console.error("Trending error:", error);
        message.textContent = "Couldn't load the charts. Check your connection and press Refresh.";
    }
}

/* ---------- TRACK HELPERS ---------- */

function getArtwork(track) { return track.artwork || ""; }
function getArtist(track) { return track.artist || "Unknown artist"; }
function isLiked(track) { return likedTracks.some(item => item.trackId === track.trackId); }

function renderTracks(tracks, container) {
    container.innerHTML = "";
    if (!tracks || !tracks.length) return;

    tracks.forEach((track, index) => {
        const card = document.createElement("div");
        card.className = "track-card";

        const artwork = getArtwork(track);
        const liked = isLiked(track);

        card.innerHTML = `
            <div class="track-art">
                ${artwork
                    ? `<img src="${artwork}" alt="" loading="lazy">`
                    : `<div class="track-art-placeholder"><i class="fa-solid fa-music"></i></div>`}
            </div>
            <button class="card-add" title="Add to playlist"><i class="fa-solid fa-plus"></i></button>
            <button class="card-heart ${liked ? "liked" : ""}" title="Like song">
                <i class="fa-${liked ? "solid" : "regular"} fa-heart"></i>
            </button>
            <button class="card-play" title="Play"><i class="fa-solid fa-play"></i></button>
            <h3></h3>
            <p></p>
        `;

        card.querySelector("h3").textContent = track.title;
        card.querySelector("p").textContent = getArtist(track);

        const coverImage = card.querySelector(".track-art img");
        if (coverImage) setArtworkFallback(coverImage);

        card.querySelector(".card-play").onclick = event => {
            event.stopPropagation();
            playTrack(track, tracks, index);
        };
        card.querySelector(".card-heart").onclick = event => {
            event.stopPropagation();
            toggleLike(track);
        };
        card.querySelector(".card-add").onclick = event => {
            event.stopPropagation();
            openPicker(track);
        };
        card.onclick = () => playTrack(track, tracks, index);

        container.appendChild(card);
    });
}

/* ---------- SEARCH ----------
   Typing only ever updates the results on this page. An artist page opens when you click
   an artist (the top-result banner or one of the profile circles), never on its own. */

const searchInput = document.getElementById("searchInput");
const searchPage = document.getElementById("search");
const normName = s => (s || "").toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");

const SEARCH_TABS = [
    ["all", "All"], ["songs", "Songs"], ["artists", "Artists"], ["albums", "Albums"], ["playlists", "Playlists"]
];
let searchTab = "all";
let lastQuery = "";

(function buildSearchTabs() {
    const row = document.getElementById("searchTabs");
    SEARCH_TABS.forEach(([key, label]) => {
        const pill = el("button", "tab-pill" + (key === searchTab ? " active" : ""), label);
        pill.dataset.tab = key;
        pill.onclick = () => {
            searchTab = key;
            searchPage.dataset.tab = key;
            row.querySelectorAll(".tab-pill").forEach(p => p.classList.toggle("active", p === pill));
        };
        row.appendChild(pill);
    });
    searchPage.dataset.tab = searchTab;
})();

searchInput.addEventListener("focus", () => navigate("search"));

function clearSearchResults(message) {
    ["searchTop", "searchArtists", "searchAlbums", "searchResults", "searchPlaylists"].forEach(id => {
        document.getElementById(id).innerHTML = "";
    });
    searchPage.classList.remove("has-results");
    document.getElementById("searchMessage").textContent = message || "Search for artists, albums and songs.";
}

searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const query = searchInput.value.trim();

    if (!query) {
        searchRequest++;
        lastQuery = "";
        clearSearchResults();
        return;
    }

    searchTimer = setTimeout(() => searchTracks(query), 350);
});

searchInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    clearTimeout(searchTimer);
    const query = searchInput.value.trim();
    if (query && query !== lastQuery) searchTracks(query);
});

async function searchAlbums(query) {
    const data = await fetchJson(
        `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=album&limit=24&country=US`
    );
    return (data.results || []).filter(item => item.collectionId);
}

/* small round picture that swaps in once the image has really loaded */
function setAvatarImage(box, url) {
    if (!url) return;
    const img = new Image();
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onload = () => { box.innerHTML = ""; box.appendChild(img); box.classList.add("has-img"); };
    img.src = url;
}

function artistChip(artist) {
    const chip = el("div", "artist-chip");
    const avatar = el("div", "avatar");
    avatar.innerHTML = '<i class="fa-solid fa-user"></i>';
    chip.appendChild(avatar);
    chip.appendChild(el("strong", "", artist.name));
    chip.appendChild(el("span", "", artist.sub || "Artist"));

    if (artist.image) setAvatarImage(avatar, artist.image);
    else deezerArtist(artist.name).then(dz => { if (dz && dz.image) setAvatarImage(avatar, dz.image); });

    chip.onclick = artist.onclick || (() => openArtist(artist.artistId));
    return chip;
}

function renderArtistChips(artists) {
    const row = document.getElementById("searchArtists");
    row.innerHTML = "";
    artists.forEach(artist => row.appendChild(artistChip({
        artistId: artist.artistId,
        name: artist.artistName,
        sub: artist.primaryGenreName || "Artist"
    })));
}

/* the big banner for the best artist match */
function pickTopArtist(artists, query) {
    const wanted = normName(query);
    if (!wanted || !artists.length) return null;

    const exact = artists.find(a => normName(a.artistName) === wanted);
    if (exact) return exact;

    const first = artists[0];
    return wanted.length >= 3 && normName(first.artistName).startsWith(wanted) ? first : null;
}

function renderTopResult(artist) {
    const box = document.getElementById("searchTop");
    box.innerHTML = "";
    if (!artist) return;

    const card = el("div", "top-result");

    const avatar = el("div", "tr-avatar");
    avatar.innerHTML = '<i class="fa-solid fa-user"></i>';
    card.appendChild(avatar);

    const info = el("div", "tr-info");
    info.appendChild(el("h2", "", artist.artistName));
    info.appendChild(el("span", "", "Artist"));
    card.appendChild(info);

    const person = { artistId: artist.artistId, name: artist.artistName, image: "" };
    deezerArtist(artist.artistName).then(dz => {
        if (!dz || !dz.image) return;
        person.image = dz.image;
        setAvatarImage(avatar, dz.image);
    });

    card.appendChild(followButton(person));

    const play = el("button", "tr-play");
    play.title = "Play";
    play.innerHTML = '<i class="fa-solid fa-play"></i>';
    play.onclick = event => { event.stopPropagation(); playArtist(artist.artistId); };
    card.appendChild(play);

    card.onclick = () => openArtist(artist.artistId);
    box.appendChild(card);
}

function renderAlbumCards(albums, grid) {
    grid.innerHTML = "";
    albums.forEach(album => {
        const card = el("div", "track-card");
        const art = el("div", "track-art");
        const url = bigArt(album.artworkUrl100);
        if (url) {
            const img = document.createElement("img");
            img.src = url;
            img.alt = "";
            img.loading = "lazy";
            art.appendChild(img);
            setArtworkFallback(img);
        } else {
            art.innerHTML = '<div class="track-art-placeholder"><i class="fa-solid fa-music"></i></div>';
        }
        card.appendChild(art);
        card.appendChild(el("h3", "", album.collectionName));
        card.appendChild(el("p", "", [
            album.releaseDate ? new Date(album.releaseDate).getFullYear() : "",
            album.artistName
        ].filter(Boolean).join(" · ")));
        card.onclick = () => openAlbum(album.collectionId);
        grid.appendChild(card);
    });
}

function renderPlaylistMatches(query) {
    const grid = document.getElementById("searchPlaylists");
    grid.innerHTML = "";
    const wanted = normName(query);
    if (!wanted) return 0;

    const matches = allPlaylists().filter(p => normName(p.name).includes(wanted));
    matches.forEach(p => {
        const card = el("div", "track-card");
        card.appendChild(buildCover(p, "track-art"));
        card.appendChild(el("h3", "", p.name));
        card.appendChild(el("p", "", "Playlist · " + countText(p.tracks.length)));
        card.onclick = () => openPlaylist(p.id);
        grid.appendChild(card);
    });
    return matches.length;
}

async function searchTracks(query) {
    const message = document.getElementById("searchMessage");
    const results = document.getElementById("searchResults");
    const requestNumber = ++searchRequest;
    lastQuery = query;

    message.textContent = "Searching…";
    results.innerHTML = "";

    try {
        const [tracks, artists, albums] = await Promise.all([
            searchApple(query),
            searchArtists(query).catch(() => []),
            searchAlbums(query).catch(() => [])
        ]);

        if (requestNumber !== searchRequest) return;

        renderTopResult(pickTopArtist(artists, query));
        renderArtistChips(artists);
        renderAlbumCards(albums, document.getElementById("searchAlbums"));
        renderTracks(tracks, results);
        const playlistCount = renderPlaylistMatches(query);

        searchPage.classList.add("has-results");
        searchPage.dataset.counts = [
            artists.length ? "artists" : "", albums.length ? "albums" : "",
            tracks.length ? "songs" : "", playlistCount ? "playlists" : ""
        ].filter(Boolean).join(" ");

        message.textContent = tracks.length || artists.length || albums.length || playlistCount
            ? ""
            : `No results found for "${query}".`;
    } catch (error) {
        if (requestNumber !== searchRequest) return;
        console.error("Search error:", error);
        message.textContent = "Search failed. Please try again.";
    }
}

/* ---------- DIALOGS ---------- */

const dialogOverlay = document.getElementById("dialogOverlay");
const dialogTitle = document.getElementById("dialogTitle");
const dialogBody = document.getElementById("dialogBody");

function openDialog(title) {
    dialogTitle.textContent = title;
    dialogBody.innerHTML = "";
    dialogOverlay.classList.add("open");
    return dialogBody;
}

function closeDialog(event) {
    if (event && event.target !== dialogOverlay) return;
    dialogOverlay.classList.remove("open");
}

function nameDialog(title, initial, label, onSubmit, placeholder = "Playlist name") {
    const body = openDialog(title);

    const input = el("input", "text-input");
    input.type = "text";
    input.maxLength = 50;
    input.placeholder = placeholder;
    input.value = initial || "";
    body.appendChild(input);

    const actions = el("div", "panel-actions");
    const cancel = el("button", "btn", "Cancel");
    const ok = el("button", "btn primary", label);

    const submit = () => {
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        closeDialog();
        onSubmit(name);
    };

    cancel.onclick = () => closeDialog();
    ok.onclick = submit;
    input.addEventListener("keydown", event => { if (event.key === "Enter") submit(); });

    actions.appendChild(ok);
    actions.appendChild(cancel);
    body.appendChild(actions);

    setTimeout(() => { input.focus(); input.select(); }, 60);
}

/* ---------- PLAYLIST DATA ---------- */

function savePlaylists() { return safeSet("musify-playlists", playlists); }
function findPlaylist(id) { return playlists.find(p => p.id === id); }
function likedPlaylist() { return { id: LIKED_ID, name: "Liked Songs", tracks: likedTracks, special: true }; }
function getPlaylist(id) { return id === LIKED_ID ? likedPlaylist() : findPlaylist(id); }
function allPlaylists() { return [likedPlaylist(), ...playlists]; }
function countText(n) { return `${n} song${n === 1 ? "" : "s"}`; }
function playlistCover(p) { return p.cover || (p.tracks[0] && p.tracks[0].artwork) || ""; }

function formatDate(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function durationText(tracks) {
    const total = Math.round(tracks.reduce((sum, t) => sum + (t.hasDuration ? t.duration : 0), 0));
    if (!total) return "";
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h} hr ${m} min` : `${m} min ${s} sec`;
}

/* a cover box: custom cover → first song's art → music icon (Liked Songs gets the gradient heart) */
function buildCover(p, cls) {
    const box = el("div", cls + (p.special ? " liked-art" : ""));
    const url = p.special ? "" : playlistCover(p);

    if (p.special) {
        box.innerHTML = '<i class="fa-solid fa-heart"></i>';
        return box;
    }

    if (url) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.onerror = () => {
            img.remove();
            const icon = document.createElement("i");
            icon.className = "fa-solid fa-music";
            box.prepend(icon);
        };
        box.appendChild(img);
    } else {
        box.innerHTML = '<i class="fa-solid fa-music"></i>';
    }
    return box;
}

function refreshLibraryViews() {
    renderSidebarLibrary();
    renderPlaylistCards(document.getElementById("homePlaylistGrid"));
    renderPlaylistCards(document.getElementById("libraryGrid"));
    renderFollowing();
    if (currentPage === "playlist") renderPlaylistView();
}

function createPlaylist(name) {
    const playlist = {
        id: "pl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        cover: "",
        tracks: []
    };
    playlists.push(playlist);
    savePlaylists();
    refreshLibraryViews();
    return playlist;
}

function createPlaylistDialog() {
    nameDialog("New playlist", "", "Create", name => {
        const playlist = createPlaylist(name);
        showToast(`Created "${name}"`);
        openPlaylist(playlist.id);
    });
}

function addToPlaylist(playlist, track) {
    if (playlist.tracks.some(item => item.trackId === track.trackId)) {
        showToast(`Already in "${playlist.name}"`);
        return false;
    }
    playlist.tracks.push({ ...track, addedAt: Date.now() });
    savePlaylists();
    refreshLibraryViews();
    showToast(`Added to "${playlist.name}"`);
    return true;
}

function openPicker(track) {
    if (!track) return;

    const body = openDialog("Add to playlist");
    body.appendChild(el("p", "dialog-sub", `${track.title} — ${getArtist(track)}`));

    const list = el("div");

    playlists.forEach(playlist => {
        const has = playlist.tracks.some(item => item.trackId === track.trackId);
        const row = el("div", "picker-item");
        row.appendChild(el("strong", "", playlist.name));
        row.appendChild(el("span", "", has ? "Added ✓" : countText(playlist.tracks.length)));
        row.onclick = () => { closeDialog(); addToPlaylist(playlist, track); };
        list.appendChild(row);
    });

    if (!playlists.length) {
        list.appendChild(el("p", "dialog-sub", "You don't have any playlists yet."));
    }

    body.appendChild(list);

    const actions = el("div", "panel-actions");
    const create = el("button", "btn primary", "+ New playlist");
    create.onclick = () => {
        nameDialog("New playlist", "", "Create", name => {
            const playlist = createPlaylist(name);
            addToPlaylist(playlist, track);
        });
    };
    actions.appendChild(create);
    body.appendChild(actions);
}

/* ---------- SIDEBAR + PLAYLIST CARDS ---------- */

function renderSidebarLibrary() {
    const list = document.getElementById("libList");
    list.innerHTML = "";

    allPlaylists().forEach(p => {
        const item = el("div", "lib-item");
        if (currentPage === "playlist" && currentPlaylistId === p.id) item.classList.add("active");

        item.appendChild(buildCover(p, "lib-thumb"));

        const meta = el("div", "lib-meta");
        meta.appendChild(el("strong", "", p.name));
        meta.appendChild(el("span", "", `Playlist · ${countText(p.tracks.length)}`));
        item.appendChild(meta);

        item.onclick = () => openPlaylist(p.id);
        list.appendChild(item);
    });
}

function renderPlaylistCards(grid) {
    grid.innerHTML = "";

    allPlaylists().forEach(p => {
        const card = el("div", "track-card");
        card.appendChild(buildCover(p, "track-art"));

        const play = el("button", "card-play");
        play.title = "Play";
        play.innerHTML = '<i class="fa-solid fa-play"></i>';
        play.onclick = event => { event.stopPropagation(); playPlaylist(p.id); };
        card.appendChild(play);

        card.appendChild(el("h3", "", p.name));
        card.appendChild(el("p", "", countText(p.tracks.length)));
        card.onclick = () => openPlaylist(p.id);

        grid.appendChild(card);
    });
}

function openPlaylist(id) { navigate("playlist", id); }

function playPlaylist(id) {
    const playlist = getPlaylist(id);
    if (!playlist || !playlist.tracks.length) {
        showToast("This playlist is empty");
        return;
    }
    playTrack(playlist.tracks[0], playlist.tracks.slice(), 0);
}

function shufflePlay(playlist) {
    if (!playlist.tracks.length) { showToast("This playlist is empty"); return; }
    setShuffle(true);
    const index = Math.floor(Math.random() * playlist.tracks.length);
    playTrack(playlist.tracks[index], playlist.tracks.slice(), index);
}

function renamePlaylist(id) {
    const playlist = findPlaylist(id);
    if (!playlist) return;

    nameDialog("Rename playlist", playlist.name, "Save", name => {
        playlist.name = name;
        savePlaylists();
        refreshLibraryViews();
        showToast("Playlist renamed");
    });
}

function deletePlaylist(id) {
    const playlist = findPlaylist(id);
    if (!playlist) return;

    const body = openDialog("Delete playlist");
    body.appendChild(el("p", "dialog-sub", `Delete "${playlist.name}"? This can't be undone.`));

    const actions = el("div", "panel-actions");
    const confirm = el("button", "btn primary", "Delete");
    const cancel = el("button", "btn", "Cancel");

    confirm.onclick = () => {
        playlists = playlists.filter(p => p.id !== id);
        savePlaylists();
        closeDialog();
        currentPlaylistId = null;
        navigate("home");
        refreshLibraryViews();
        showToast("Playlist deleted");
    };
    cancel.onclick = () => closeDialog();

    actions.appendChild(confirm);
    actions.appendChild(cancel);
    body.appendChild(actions);
}

function removeFromPlaylist(id, trackId) {
    const playlist = findPlaylist(id);
    if (!playlist) return;

    playlist.tracks = playlist.tracks.filter(item => item.trackId !== trackId);
    savePlaylists();
    refreshLibraryViews();
    showToast("Removed from playlist");
}

/* ---------- CUSTOM PLAYLIST COVERS ---------- */

const coverInput = document.getElementById("coverInput");
let coverTarget = null;
let coverCallback = null;

function pickCover(id, callback) {
    coverTarget = id;
    coverCallback = callback || null;
    coverInput.value = "";
    coverInput.click();
}

/* center-crops to a square and shrinks it so it fits in browser storage */
function resizeImage(file, size) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = size;
            const ctx = canvas.getContext("2d");
            const side = Math.min(img.width, img.height);
            ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
            resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Bad image")); };
        img.src = url;
    });
}

coverInput.addEventListener("change", async () => {
    const file = coverInput.files && coverInput.files[0];
    const playlist = findPlaylist(coverTarget);
    if (!file || !playlist) return;

    if (!file.type.startsWith("image/")) { showToast("Please choose an image file"); return; }

    try {
        playlist.cover = await resizeImage(file, 500);
        const saved = savePlaylists();
        refreshLibraryViews();
        if (coverCallback) coverCallback();
        showToast(saved ? "Cover updated" : "Cover updated, but storage is full so it won't be kept");
    } catch {
        showToast("Couldn't load that image");
    }
});

function removeCover(playlist, callback) {
    playlist.cover = "";
    savePlaylists();
    refreshLibraryViews();
    if (callback) callback();
    showToast("Cover removed");
}

function editDetailsDialog(playlist) {
    const body = openDialog("Name & details");

    const top = el("div", "details-top");
    let preview = buildCover(playlist, "details-cover");
    const refreshPreview = () => {
        const next = buildCover(playlist, "details-cover");
        preview.replaceWith(next);
        preview = next;
    };

    const buttons = el("div", "details-buttons");
    const choose = el("button", "btn", "Choose photo");
    choose.onclick = () => pickCover(playlist.id, refreshPreview);
    const remove = el("button", "btn", "Remove photo");
    remove.onclick = () => removeCover(playlist, refreshPreview);
    buttons.appendChild(choose);
    buttons.appendChild(remove);

    top.appendChild(preview);
    top.appendChild(buttons);
    body.appendChild(top);

    const input = el("input", "text-input");
    input.type = "text";
    input.maxLength = 50;
    input.placeholder = "Playlist name";
    input.value = playlist.name;
    body.appendChild(input);

    const actions = el("div", "panel-actions");
    const save = el("button", "btn primary", "Save");
    const cancel = el("button", "btn", "Cancel");

    const submit = () => {
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        playlist.name = name;
        savePlaylists();
        refreshLibraryViews();
        closeDialog();
        showToast("Playlist updated");
    };
    save.onclick = submit;
    cancel.onclick = () => closeDialog();
    input.addEventListener("keydown", event => { if (event.key === "Enter") submit(); });

    actions.appendChild(save);
    actions.appendChild(cancel);
    body.appendChild(actions);
}

function playlistMenu(playlist) {
    const body = openDialog(playlist.name);

    const options = [
        ["fa-pen", "Name & details", () => editDetailsDialog(playlist)],
        ["fa-image", "Change cover", () => pickCover(playlist.id)]
    ];
    if (playlist.cover) options.push(["fa-xmark", "Remove cover", () => removeCover(playlist)]);
    options.push(["fa-trash", "Delete playlist", () => deletePlaylist(playlist.id)]);

    options.forEach(([icon, label, action]) => {
        const row = el("div", "picker-item");
        const text = el("span", "lbl");
        text.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        text.appendChild(document.createTextNode(label));
        row.appendChild(text);
        row.onclick = () => { closeDialog(); action(); };
        body.appendChild(row);
    });
}

/* ---------- ADD SONGS TO A PLAYLIST ---------- */

function addSongsDialog(playlist) {
    const body = openDialog("Add songs");

    const input = el("input", "text-input");
    input.type = "text";
    input.placeholder = "Search for songs";
    input.autocomplete = "off";
    body.appendChild(input);

    const list = el("div");
    list.style.marginTop = "12px";
    list.appendChild(el("p", "dialog-sub", `Search Apple Music to add songs to "${playlist.name}".`));
    body.appendChild(list);

    let timer = null;
    let request = 0;

    input.addEventListener("input", () => {
        clearTimeout(timer);
        const query = input.value.trim();

        if (!query) {
            request++;
            list.innerHTML = "";
            return;
        }

        timer = setTimeout(async () => {
            const current = ++request;
            list.innerHTML = "";
            list.appendChild(el("p", "dialog-sub", "Searching…"));

            try {
                const tracks = (await searchApple(query)).slice(0, 25);
                if (current !== request) return;
                list.innerHTML = "";

                if (!tracks.length) {
                    list.appendChild(el("p", "dialog-sub", "No results found."));
                    return;
                }

                tracks.forEach(track => {
                    const row = el("div", "add-row");

                    if (track.artwork) {
                        const img = document.createElement("img");
                        img.src = track.artwork;
                        img.alt = "";
                        img.loading = "lazy";
                        img.referrerPolicy = "no-referrer";
                        row.appendChild(img);
                    } else {
                        row.appendChild(el("div", "thumb"));
                    }

                    const text = el("div");
                    text.appendChild(el("strong", "", track.title));
                    text.appendChild(el("span", "", getArtist(track)));
                    row.appendChild(text);

                    const has = playlist.tracks.some(item => item.trackId === track.trackId);
                    const button = el("button", "btn", has ? "Added" : "Add");
                    button.disabled = has;
                    button.onclick = () => {
                        if (addToPlaylist(playlist, track)) {
                            button.textContent = "Added";
                            button.disabled = true;
                        }
                    };
                    row.appendChild(button);

                    list.appendChild(row);
                });
            } catch {
                if (current !== request) return;
                list.innerHTML = "";
                list.appendChild(el("p", "dialog-sub", "Search failed. Please try again."));
            }
        }, 350);
    });

    setTimeout(() => input.focus(), 60);
}
/* ---------- PLAYLIST PAGE ---------- */

const colorCache = {};

function hashColor(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 28%)`;
}

/* picks a rich color from the cover for the page header; resolves null if the image can't be read */
function extractColor(url) {
    return new Promise(resolve => {
        if (!url) return resolve(null);
        if (colorCache[url]) return resolve(colorCache[url]);

        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = canvas.height = 16;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, 16, 16);
                const data = ctx.getImageData(0, 0, 16, 16).data;

                let r = 0, g = 0, b = 0, total = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const weight = (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])) + 16;
                    r += data[i] * weight;
                    g += data[i + 1] * weight;
                    b += data[i + 2] * weight;
                    total += weight;
                }
                r /= total; g /= total; b /= total;

                const peak = Math.max(r, g, b) || 1;
                const scale = Math.min(1, 175 / peak) * 0.85;
                const color = `rgb(${Math.round(r * scale)},${Math.round(g * scale)},${Math.round(b * scale)})`;
                colorCache[url] = color;
                resolve(color);
            } catch { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

function renderPlaylistView() {
    const view = document.getElementById("playlistView");
    view.innerHTML = "";

    const playlist = getPlaylist(currentPlaylistId);

    if (!playlist) {
        view.appendChild(el("h1", "page-heading", "Playlist not found"));
        view.appendChild(el("p", "page-subtitle", "This playlist doesn't exist anymore."));
        return;
    }

    const wrap = el("div", "pl-wrap");
    wrap.style.setProperty("--pl-color", playlist.special ? "#3d2a96" : hashColor(playlist.name));

    const coverUrl = playlist.special ? "" : playlistCover(playlist);
    if (coverUrl) {
        extractColor(coverUrl).then(color => {
            if (color && wrap.isConnected) wrap.style.setProperty("--pl-color", color);
        });
    }

    /* header */
    const hero = el("div", "pl-hero");

    const cover = buildCover(playlist, "pl-cover");
    if (!playlist.special) {
        cover.classList.add("editable");
        cover.title = "Change cover";
        cover.tabIndex = 0;
        cover.setAttribute("role", "button");
        const edit = el("div", "pl-cover-edit");
        edit.innerHTML = '<i class="fa-solid fa-camera"></i><span>Choose photo</span>';
        cover.appendChild(edit);
        cover.onclick = () => pickCover(playlist.id);
        cover.onkeydown = event => { if (event.key === "Enter") pickCover(playlist.id); };
    }
    hero.appendChild(cover);

    const info = el("div", "pl-info");
    info.appendChild(el("div", "pl-kind", playlist.special ? "Playlist" : "Private Playlist"));

    const title = el("h1", "pl-title", playlist.name);
    if (playlist.name.length > 22) title.classList.add("long");
    if (!playlist.special) {
        title.classList.add("editable");
        title.onclick = () => editDetailsDialog(playlist);
    }
    info.appendChild(title);

    const owner = el("div", "pl-owner");
    const avatar = el("span", "pl-avatar");
    avatar.innerHTML = '<i class="fa-solid fa-user"></i>';
    owner.appendChild(avatar);
    owner.appendChild(el("strong", "", displayName));
    const length = durationText(playlist.tracks);
    owner.appendChild(el("span", "pl-meta", "• " + countText(playlist.tracks.length) + (length ? ", " + length : "")));
    info.appendChild(owner);
    hero.appendChild(info);
    wrap.appendChild(hero);

    /* controls */
    const controls = el("div", "pl-controls");

    const play = el("button", "pl-play");
    play.title = "Play";
    play.innerHTML = '<i class="fa-solid fa-play"></i>';
    play.disabled = !playlist.tracks.length;
    play.onclick = () => playPlaylist(playlist.id);
    controls.appendChild(play);

    if (!playlist.special) {
        const small = buildCover(playlist, "pl-small-cover");
        small.title = "Change cover";
        small.setAttribute("role", "button");
        small.onclick = () => pickCover(playlist.id);
        controls.appendChild(small);
    }

    const shuffle = el("button", "pl-icon-btn pl-shuffle" + (shuffleEnabled ? " selected" : ""));
    shuffle.title = "Shuffle";
    shuffle.innerHTML = '<i class="fa-solid fa-shuffle"></i>';
    shuffle.onclick = () => shufflePlay(playlist);
    controls.appendChild(shuffle);

    if (!playlist.special) {
        const more = el("button", "pl-icon-btn");
        more.title = "More options";
        more.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
        more.onclick = () => playlistMenu(playlist);
        controls.appendChild(more);
    }
    wrap.appendChild(controls);

    if (!playlist.special) {
        const pills = el("div", "pl-pills");

        const add = el("button", "pill");
        add.innerHTML = '<i class="fa-solid fa-plus"></i> Add';
        add.onclick = () => addSongsDialog(playlist);

        const details = el("button", "pill");
        details.innerHTML = '<i class="fa-solid fa-pen"></i> Name &amp; details';
        details.onclick = () => editDetailsDialog(playlist);

        pills.appendChild(add);
        pills.appendChild(details);
        wrap.appendChild(pills);
    }

    /* song table */
    if (!playlist.tracks.length) {
        wrap.appendChild(el("p", "pl-empty", playlist.special
            ? "Songs you like will show up here. Tap the heart on any song."
            : "This playlist is empty. Press Add to search for songs, or use the + button on any song."));
        view.appendChild(wrap);
        return;
    }

    const head = el("div", "pl-head");
    head.appendChild(el("div", "num", "#"));
    head.appendChild(el("div", "", "Title"));
    head.appendChild(el("div", "album", "Album"));
    head.appendChild(el("div", "added", "Date added"));
    const clock = el("div", "time");
    clock.innerHTML = '<i class="fa-regular fa-clock"></i>';
    head.appendChild(clock);
    head.appendChild(el("div"));
    wrap.appendChild(head);

    const tracks = playlist.tracks.slice();

    tracks.forEach((track, index) => {
        const row = el("div", "pl-row");

        const num = el("div", "num");
        num.appendChild(el("span", "n", String(index + 1)));
        const playIcon = document.createElement("i");
        playIcon.className = "fa-solid fa-play";
        num.appendChild(playIcon);
        row.appendChild(num);

        const cell = el("div", "pl-title-cell");
        if (track.artwork) {
            const img = document.createElement("img");
            img.src = track.artwork;
            img.alt = "";
            img.loading = "lazy";
            img.referrerPolicy = "no-referrer";
            cell.appendChild(img);
        } else {
            cell.appendChild(el("div", "thumb"));
        }
        const text = el("div");
        text.style.minWidth = "0";
        text.appendChild(el("strong", "", track.title));
        text.appendChild(el("small", "", getArtist(track)));
        cell.appendChild(text);
        row.appendChild(cell);

        row.appendChild(el("div", "album", track.album));
        row.appendChild(el("div", "added", formatDate(track.addedAt)));
        row.appendChild(el("div", "time", track.hasDuration ? formatTime(track.duration) : ""));

        const actions = el("div", "row-actions");
        const button = el("button", "row-btn");
        button.title = playlist.special ? "Remove from Liked Songs" : "Remove from playlist";
        button.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        button.onclick = event => {
            event.stopPropagation();
            if (playlist.special) toggleLike(track);
            else removeFromPlaylist(playlist.id, track.trackId);
        };
        actions.appendChild(button);
        row.appendChild(actions);

        row.onclick = () => playTrack(track, tracks, index);
        wrap.appendChild(row);
    });

    view.appendChild(wrap);
}

/* ---------- DISPLAY NAME ---------- */

function updateNameStatus() {
    document.getElementById("nameStatus").textContent = `Shown as the owner of your playlists: ${displayName}`;
}

function changeDisplayName() {
    nameDialog("Display name", displayName, "Save", name => {
        displayName = name;
        safeSet("musify-name", displayName);
        updateNameStatus();
        refreshLibraryViews();
        showToast("Display name updated");
    }, "Your name");
}

/* ---------- ARTIST + ALBUM PAGES ---------- */

function bigArt(url) {
    return url ? url.replace(/\/\d+x\d+bb\./, "/600x600bb.").replace("http://", "https://") : "";
}

function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
    return String(n);
}

/* ----- Deezer: artist photos, fan counts and "fans also like" (Apple has none of these) ----- */

function jsonp(url, timeout = 6000) {
    return new Promise((resolve, reject) => {
        const name = "dz" + Math.random().toString(36).slice(2);
        const script = document.createElement("script");
        const finish = () => { clearTimeout(timer); delete window[name]; script.remove(); };
        const timer = setTimeout(() => { finish(); reject(new Error("timeout")); }, timeout);

        window[name] = data => { finish(); resolve(data); };
        script.onerror = () => { finish(); reject(new Error("blocked")); };
        script.src = url + (url.includes("?") ? "&" : "?") + "output=jsonp&callback=" + name;
        document.head.appendChild(script);
    });
}

const deezerCache = {};

/* Deezer hands out a blank placeholder image for artists without a photo */
const realPicture = url => (url && !/\/artist\/\//.test(url) ? url : "");

function deezerArtist(name) {
    const key = normName(name);
    if (!key) return Promise.resolve(null);
    if (deezerCache[key]) return deezerCache[key];

    deezerCache[key] = jsonp(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=6`)
        .then(data => {
            const hit = ((data && data.data) || []).find(a => normName(a.name) === key);
            return hit ? {
                id: hit.id,
                name: hit.name,
                image: realPicture(hit.picture_xl) || realPicture(hit.picture_big),
                fans: hit.nb_fan || 0
            } : null;
        })
        .catch(() => { delete deezerCache[key]; return null; });

    return deezerCache[key];
}

function deezerRelated(deezerId) {
    return jsonp(`https://api.deezer.com/artist/${deezerId}/related?limit=14`)
        .then(data => ((data && data.data) || []).map(a => ({
            name: a.name,
            image: realPicture(a.picture_big) || realPicture(a.picture_medium)
        })))
        .catch(() => []);
}

/* ----- following ----- */

let following = loadSaved("musify-following").filter(a => a && a.artistId && a.name);
const isFollowing = id => following.some(a => String(a.artistId) === String(id));

function toggleFollow(artist) {
    const index = following.findIndex(a => String(a.artistId) === String(artist.artistId));

    if (index >= 0) {
        following.splice(index, 1);
        showToast(`Unfollowed ${artist.name}`);
    } else {
        following.push({ artistId: String(artist.artistId), name: artist.name, image: artist.image || "" });
        showToast(`Following ${artist.name}`);
    }

    safeSet("musify-following", following);
    document.querySelectorAll(".follow-btn").forEach(button => button.paint && button.paint());
    renderFollowing();
}

function followButton(artist) {
    const button = el("button", "follow-btn");
    button.paint = () => {
        const on = isFollowing(artist.artistId);
        button.textContent = on ? "Following" : "Follow";
        button.classList.toggle("on", on);
    };
    button.onclick = event => { event.stopPropagation(); toggleFollow(artist); };
    button.paint();
    return button;
}

function renderFollowing() {
    const section = document.getElementById("libraryArtistsSection");
    const row = document.getElementById("libraryArtists");
    if (!section || !row) return;

    row.innerHTML = "";
    following.forEach(a => row.appendChild(artistChip({
        artistId: a.artistId, name: a.name, image: a.image, sub: "Artist"
    })));
    section.style.display = following.length ? "" : "none";
}

/* ----- loading an artist ----- */

const artistDataCache = {};

function loadArtistData(artistId) {
    if (artistDataCache[artistId]) return artistDataCache[artistId];

    artistDataCache[artistId] = Promise.all([
        fetchJson(`https://itunes.apple.com/lookup?id=${artistId}&entity=song&limit=50&country=US`),
        fetchJson(`https://itunes.apple.com/lookup?id=${artistId}&entity=album&limit=200&country=US`)
    ]).then(([songData, albumData]) => {
        const artist = (songData.results || []).find(r => r.wrapperType === "artist")
            || (albumData.results || []).find(r => r.wrapperType === "artist");
        if (!artist) throw new Error("Artist not found");

        const seenSongs = new Set();
        const songs = (songData.results || [])
            .filter(r => r.wrapperType === "track")
            .map(normalizeAppleTrack)
            .filter(t => {
                const key = normName(t.title);
                if (seenSongs.has(key)) return false;
                seenSongs.add(key);
                return true;
            });

        const seenAlbums = new Set();
        const albums = (albumData.results || [])
            .filter(r => r.wrapperType === "collection" && r.collectionName)
            .sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate))
            .filter(a => {
                const key = a.collectionName.toLowerCase();
                if (seenAlbums.has(key)) return false;
                seenAlbums.add(key);
                return true;
            });

        return { artist, songs, albums };
    }).catch(error => { delete artistDataCache[artistId]; throw error; });

    return artistDataCache[artistId];
}

async function playArtist(artistId, shuffle) {
    try {
        const { songs } = await loadArtistData(artistId);
        if (!songs.length) { showToast("No songs found for this artist"); return; }
        if (shuffle) setShuffle(true);
        const index = shuffle ? Math.floor(Math.random() * songs.length) : 0;
        playTrack(songs[index], songs.slice(), index);
    } catch { showToast("Couldn't load this artist"); }
}

const isSingleOrEp = album => /\s-\s(single|ep)$/i.test(album.collectionName) || album.trackCount <= 3;

/* ----- one song row (used for Popular and for album tracklists) ----- */

function songRow(track, index, tracks, sub) {
    const row = el("div", "song-row");
    row.appendChild(el("span", "num", String(index + 1)));

    if (track.artwork) {
        const img = document.createElement("img");
        img.src = track.artwork;
        img.alt = "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        row.appendChild(img);
    } else {
        row.appendChild(el("div", "thumb"));
    }

    const text = el("div");
    text.style.minWidth = "0";
    text.appendChild(el("strong", "", track.title));
    text.appendChild(el("small", "", sub(track)));
    row.appendChild(text);

    row.appendChild(el("span", "time", track.hasDuration ? formatTime(track.duration) : ""));

    const actions = el("div", "row-actions");

    const heart = el("button", "row-btn");
    const paintHeart = () => {
        const liked = isLiked(track);
        heart.title = liked ? "Remove from Liked Songs" : "Save to Liked Songs";
        heart.classList.toggle("liked", liked);
        heart.innerHTML = `<i class="fa-${liked ? "solid" : "regular"} fa-heart"></i>`;
    };
    paintHeart();
    heart.onclick = event => { event.stopPropagation(); toggleLike(track); paintHeart(); };
    actions.appendChild(heart);

    const add = el("button", "row-btn");
    add.title = "Add to playlist";
    add.innerHTML = '<i class="fa-solid fa-plus"></i>';
    add.onclick = event => { event.stopPropagation(); openPicker(track); };
    actions.appendChild(add);

    row.appendChild(actions);
    row.onclick = () => playTrack(track, tracks, index);
    return row;
}

function songSection(title, tracks, sub = t => t.album) {
    const section = el("div", "profile-section");
    if (title) section.appendChild(el("h2", "", title));

    if (!tracks.length) {
        section.appendChild(el("p", "profile-loading", "No songs found."));
        return section;
    }

    tracks.forEach((track, index) => section.appendChild(songRow(track, index, tracks, sub)));
    return section;
}

/* ----- cross-fading banner image ----- */

function setBanner(hero, url, blurred) {
    if (!url) return;
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
        if (!hero.isConnected) return;
        const layer = el("div", "ar-layer" + (blurred ? " blurred" : ""));
        layer.style.backgroundImage = `url("${url}")`;
        hero.querySelector(".ar-bg").appendChild(layer);
        requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add("show")));
        setTimeout(() => {
            const layers = hero.querySelectorAll(".ar-layer");
            for (let i = 0; i < layers.length - 1; i++) layers[i].remove();
        }, 800);
    };
    img.src = url;
}

/* ----- the artist page ----- */

async function renderArtistPage(artistId) {
    const view = document.getElementById("artistView");
    view.innerHTML = "";
    view.appendChild(el("p", "profile-loading", "Loading artist…"));

    const stale = () => currentPage !== "artist" || currentEntityId !== artistId;

    try {
        const { artist, songs, albums } = await loadArtistData(artistId);
        if (stale()) return;

        const name = artist.artistName;
        const person = { artistId: String(artistId), name, image: "" };
        const latestArt = albums[0] ? bigArt(albums[0].artworkUrl100) : (songs[0] && songs[0].artwork) || "";

        const wrap = el("div", "ar-wrap");
        wrap.style.setProperty("--ar-color", hashColor(name));

        /* banner */
        const hero = el("div", "ar-hero");
        hero.appendChild(el("div", "ar-bg"));
        hero.appendChild(el("div", "ar-shade"));

        const heroBody = el("div", "ar-hero-body");
        const kind = el("div", "ar-kind");
        kind.innerHTML = '<i class="fa-solid fa-microphone-lines"></i> Artist';
        heroBody.appendChild(kind);

        const title = el("h1", "ar-name", name);
        if (name.length > 16) title.classList.add("long");
        heroBody.appendChild(title);

        const stats = el("div", "ar-stats", artist.primaryGenreName || "");
        heroBody.appendChild(stats);
        hero.appendChild(heroBody);
        wrap.appendChild(hero);

        setBanner(hero, latestArt, true);   /* shown straight away, replaced by the real photo if there is one */

        /* controls */
        const controls = el("div", "ar-controls");

        const play = el("button", "pl-play");
        play.title = "Play";
        play.innerHTML = '<i class="fa-solid fa-play"></i>';
        play.disabled = !songs.length;
        play.onclick = () => playArtist(artistId, false);
        controls.appendChild(play);

        const shuffle = el("button", "pl-icon-btn pl-shuffle" + (shuffleEnabled ? " selected" : ""));
        shuffle.title = "Shuffle";
        shuffle.innerHTML = '<i class="fa-solid fa-shuffle"></i>';
        shuffle.disabled = !songs.length;
        shuffle.onclick = () => playArtist(artistId, true);
        controls.appendChild(shuffle);

        controls.appendChild(followButton(person));
        wrap.appendChild(controls);

        /* popular */
        if (songs.length) {
            const popular = el("div", "profile-section ar-popular");
            popular.appendChild(el("h2", "", "Popular"));

            const list = el("div");
            popular.appendChild(list);

            let expanded = false;
            const more = el("button", "ar-more");

            const paint = () => {
                list.innerHTML = "";
                songs.slice(0, expanded ? 10 : 5).forEach((track, index) =>
                    list.appendChild(songRow(track, index, songs, t => t.album)));
                more.textContent = expanded ? "Show less" : "See more";
                more.style.display = songs.length > 5 ? "" : "none";
            };
            more.onclick = () => { expanded = !expanded; paint(); };
            paint();

            popular.appendChild(more);
            wrap.appendChild(popular);
        }

        /* discography */
        if (albums.length) {
            const releases = albums.filter(a => !isSingleOrEp(a));
            const singles = albums.filter(isSingleOrEp);

            const order = [];
            songs.forEach(s => { if (s.albumId && !order.includes(s.albumId)) order.push(s.albumId); });
            const popularReleases = order.map(id => albums.find(a => a.collectionId === id)).filter(Boolean);
            albums.forEach(a => { if (!popularReleases.includes(a)) popularReleases.push(a); });

            const tabs = [["Popular releases", popularReleases], ["Albums", releases], ["Singles & EPs", singles]]
                .filter(([, list]) => list.length);

            const section = el("div", "profile-section");
            section.appendChild(el("h2", "", "Discography"));

            const tabRow = el("div", "tab-row");
            const grid = el("div", "music-grid album-grid");
            const showAll = el("button", "ar-more");
            section.appendChild(tabRow);
            section.appendChild(grid);
            section.appendChild(showAll);

            let active = 0;
            let all = false;

            const paint = () => {
                const list = tabs[active][1];
                renderAlbumCards(all ? list : list.slice(0, 12), grid);
                tabRow.querySelectorAll(".tab-pill").forEach((p, i) => p.classList.toggle("active", i === active));
                showAll.style.display = list.length > 12 ? "" : "none";
                showAll.textContent = all ? "Show less" : `Show all ${list.length}`;
            };

            tabs.forEach(([label], i) => {
                const pill = el("button", "tab-pill", label);
                pill.onclick = () => { active = i; all = false; paint(); };
                tabRow.appendChild(pill);
            });
            showAll.onclick = () => { all = !all; paint(); };
            paint();

            wrap.appendChild(section);
        }

        if (!songs.length && !albums.length) {
            wrap.appendChild(el("p", "profile-loading", "Nothing to show for this artist yet."));
        }

        view.innerHTML = "";
        view.appendChild(wrap);

        /* the real photo, fan count and similar artists arrive a moment later */
        deezerArtist(name).then(async dz => {
            if (stale() || !wrap.isConnected || !dz) return;

            if (dz.fans) {
                stats.textContent = [`${dz.fans.toLocaleString("en-US")} fans`, artist.primaryGenreName].filter(Boolean).join(" · ");
            }

            if (dz.image) {
                person.image = dz.image;
                setBanner(hero, dz.image, false);
                extractColor(dz.image).then(color => { if (color && wrap.isConnected) wrap.style.setProperty("--ar-color", color); });
            }

            const related = (await deezerRelated(dz.id)).filter(r => normName(r.name) !== normName(name));
            if (stale() || !wrap.isConnected || !related.length) return;

            const section = el("div", "profile-section");
            section.appendChild(el("h2", "", "Fans also like"));
            const row = el("div", "artist-row flush");

            related.forEach(r => row.appendChild(artistChip({
                name: r.name,
                image: r.image,
                sub: "Artist",
                onclick: () => openArtistByName(r.name)
            })));

            section.appendChild(row);
            wrap.appendChild(section);
        });
    } catch (error) {
        console.error("Artist error:", error);
        if (renderedEntity === "artist:" + artistId) renderedEntity = "";
        view.innerHTML = "";
        view.appendChild(el("p", "profile-loading", "Couldn’t load this artist. Check your connection and try again."));
    }
}

/* "fans also like" only knows names, so find the matching Apple artist first */
async function openArtistByName(name) {
    try {
        const artists = await searchArtists(name);
        const hit = artists.find(a => normName(a.artistName) === normName(name)) || artists[0];
        if (hit) openArtist(hit.artistId);
        else showToast("Couldn't find that artist");
    } catch { showToast("Couldn't find that artist"); }
}

/* ----- the album page ----- */

async function renderAlbumPage(collectionId) {
    const view = document.getElementById("albumView");
    view.innerHTML = "";
    view.appendChild(el("p", "profile-loading", "Loading album…"));

    const stale = () => currentPage !== "album" || currentEntityId !== collectionId;

    try {
        const data = await fetchJson(`https://itunes.apple.com/lookup?id=${collectionId}&entity=song&country=US`);
        if (stale()) return;

        const album = (data.results || []).find(r => r.wrapperType === "collection");
        const tracks = (data.results || []).filter(r => r.wrapperType === "track").map(normalizeAppleTrack);
        if (!album) throw new Error("Album not found");

        const art = bigArt(album.artworkUrl100 || "");
        const wrap = el("div", "pl-wrap");
        wrap.style.setProperty("--pl-color", hashColor(album.collectionName));
        if (art) extractColor(art).then(color => { if (color && wrap.isConnected) wrap.style.setProperty("--pl-color", color); });

        const hero = el("div", "pl-hero");
        const cover = el("div", "pl-cover");
        if (art) {
            const img = document.createElement("img");
            img.src = art;
            img.alt = "";
            img.referrerPolicy = "no-referrer";
            img.onerror = () => { img.remove(); cover.innerHTML = '<i class="fa-solid fa-music"></i>'; };
            cover.appendChild(img);
        } else {
            cover.innerHTML = '<i class="fa-solid fa-music"></i>';
        }
        hero.appendChild(cover);

        const info = el("div", "pl-info");
        info.appendChild(el("div", "pl-kind", isSingleOrEp(album) ? "Single / EP" : "Album"));

        const title = el("h1", "pl-title", album.collectionName);
        if (album.collectionName.length > 22) title.classList.add("long");
        info.appendChild(title);

        const owner = el("div", "pl-owner");
        if (album.artistId) {
            const who = el("button", "profile-link inline", album.artistName);
            who.onclick = () => openArtist(album.artistId);
            owner.appendChild(who);
        } else {
            owner.appendChild(el("strong", "", album.artistName || ""));
        }
        const length = durationText(tracks);
        owner.appendChild(el("span", "pl-meta", "• " + [
            album.releaseDate ? new Date(album.releaseDate).getFullYear() : "",
            countText(tracks.length) + (length ? ", " + length : "")
        ].filter(Boolean).join(" • ")));
        info.appendChild(owner);
        hero.appendChild(info);
        wrap.appendChild(hero);

        const controls = el("div", "pl-controls");
        const play = el("button", "pl-play");
        play.title = "Play";
        play.innerHTML = '<i class="fa-solid fa-play"></i>';
        play.disabled = !tracks.length;
        play.onclick = () => playTrack(tracks[0], tracks.slice(), 0);
        controls.appendChild(play);

        const shuffle = el("button", "pl-icon-btn pl-shuffle" + (shuffleEnabled ? " selected" : ""));
        shuffle.title = "Shuffle";
        shuffle.innerHTML = '<i class="fa-solid fa-shuffle"></i>';
        shuffle.disabled = !tracks.length;
        shuffle.onclick = () => {
            setShuffle(true);
            const index = Math.floor(Math.random() * tracks.length);
            playTrack(tracks[index], tracks.slice(), index);
        };
        controls.appendChild(shuffle);
        wrap.appendChild(controls);

        const list = songSection("", tracks, t => getArtist(t));
        list.classList.add("flush");
        wrap.appendChild(list);

        view.innerHTML = "";
        view.appendChild(wrap);
    } catch (error) {
        console.error("Album error:", error);
        if (renderedEntity === "album:" + collectionId) renderedEntity = "";
        view.innerHTML = "";
        view.appendChild(el("p", "profile-loading", "Couldn’t load this album."));
    }
}

function openArtist(artistId) { if (artistId) navigate("artist", String(artistId)); }
function openAlbum(collectionId) { if (collectionId) navigate("album", String(collectionId)); }

/* ============================================================
   FULL SONG STREAMING
   Order of preference:
     1. YouTube Music audio  (Piped API, "music songs" search)  ┐ raced in parallel,
     2. YouTube audio        (Invidious API, "- Topic" first)   ┘ first playable one wins
     3. 30 second Apple preview (only if neither of the above works)
   ============================================================ */

const FALLBACK_INSTANCES = [
    "https://yt.omada.cafe",
    "https://invidious.schenkel.eti.br",
    "https://invidious.kemonomimi.nl",
    "https://echostreamz.com",
    "https://inv.nadeko.net",
    "https://yewtu.be",
    "https://invidious.nerdvpn.de",
    "https://invidious.privacyredirect.com"
];

const PIPED_FALLBACK = [
    "https://pipedapi.kavin.rocks",
    "https://api.piped.private.coffee",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.nosebs.ru",
    "https://pipedapi.reallyaweso.me",
    "https://pipedapi.darkness.services",
    "https://piped-api.garudalinux.org",
    "https://pipedapi.orangenet.cc"
];

let instanceCache = null;
let pipedCache = null;
let playToken = 0;
let audioMode = "none";
let probing = false;
let probeCounter = 0;
let recoveredToken = 0;

/* in-memory copy so song lookups still work (and can be prefetched) when saving is turned off */
const idMemo = {};

function getSavedVideoId(trackId) {
    if (idMemo[trackId]) return idMemo[trackId];
    const cache = safeGet("musify-yt-ids", {});
    return cache[trackId] || "";
}

function saveVideoId(trackId, videoId, force) {
    if (!force && getSavedVideoId(trackId)) return;
    idMemo[trackId] = videoId;
    const cache = safeGet("musify-yt-ids", {});
    cache[trackId] = videoId;
    const keys = Object.keys(cache);
    if (keys.length > 600) {
        keys.slice(0, keys.length - 600).forEach(key => delete cache[key]);
    }
    safeSet("musify-yt-ids", cache);
}

function resetAudioCache() {
    try {
        localStorage.removeItem("musify-yt-ids");
        localStorage.removeItem("musify-instances");
        localStorage.removeItem("musify-piped");
        localStorage.removeItem("musify-fast-source");
        localStorage.removeItem("musify-fast-piped");
    } catch {}
    Object.keys(idMemo).forEach(key => delete idMemo[key]);
    instanceCache = null;
    pipedCache = null;
    setNote("Audio sources cleared");
}

function setNote(text) {
    const element = document.getElementById("trackArtist");
    if (!currentTrack) {
        element.textContent = text || "Select a song to get started.";
        return;
    }
    element.textContent = getArtist(currentTrack) + (text ? " · " + text : "");
}

/* ---------- server lists ---------- */

async function getInstances() {
    if (instanceCache) return instanceCache;

    let live = [];
    const cached = safeGet("musify-instances", null);

    if (cached && Array.isArray(cached.list) && cached.list.length && Date.now() - cached.time < 3600000) {
        live = cached.list;
    } else {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            const data = await fetchJson("https://api.invidious.io/instances.json?sort_by=health", controller.signal);
            clearTimeout(timer);

            live = data
                .filter(entry => entry[1] && entry[1].api === true && entry[1].cors === true && entry[1].type === "https" && entry[1].uri)
                .map(entry => entry[1].uri.replace(/\/+$/, ""))
                .slice(0, 10);

            if (live.length) safeSet("musify-instances", { time: Date.now(), list: live });
        } catch { live = []; }
    }

    const preferred = safeGet("musify-fast-source", "");
    instanceCache = [...new Set([preferred, ...live, ...FALLBACK_INSTANCES].filter(Boolean))];
    return instanceCache;
}

async function getPipedInstances() {
    if (pipedCache) return pipedCache;

    let live = [];
    const cached = safeGet("musify-piped", null);

    if (cached && Array.isArray(cached.list) && cached.list.length && Date.now() - cached.time < 3600000) {
        live = cached.list;
    } else {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const data = await fetchJson("https://piped-instances.kavin.rocks/", controller.signal);
            clearTimeout(timer);

            live = (Array.isArray(data) ? data : [])
                .filter(item => item && item.api_url && item.up_to_date !== false)
                .map(item => String(item.api_url).replace(/\/+$/, ""))
                .slice(0, 10);

            if (live.length) safeSet("musify-piped", { time: Date.now(), list: live });
        } catch { live = []; }
    }

    const preferred = safeGet("musify-fast-piped", "");
    pipedCache = [...new Set([preferred, ...live, ...PIPED_FALLBACK].filter(Boolean))];
    return pipedCache;
}

/* ---------- request helpers ---------- */

async function firstSuccess(instances, makeRequest, isCancelled) {
    const controllers = instances.map(() => new AbortController());

    const attempts = instances.map(async (instance, index) => {
        if (index) await new Promise(resolve => setTimeout(resolve, index * 150));
        if (isCancelled()) throw new Error("cancelled");

        const timer = setTimeout(() => controllers[index].abort(), 7000);
        try {
            const data = await makeRequest(instance, controllers[index].signal);
            return { data, instance, index };
        } finally { clearTimeout(timer); }
    });

    try {
        const winner = await Promise.any(attempts);
        controllers.forEach((controller, index) => { if (index !== winner.index) controller.abort(); });
        return winner;
    } catch {
        controllers.forEach(controller => controller.abort());
        return null;
    }
}

/* tries the servers three at a time until one answers */
async function tryBatches(instances, makeRequest, stop, limit = 9) {
    for (let start = 0; start < instances.length && start < limit; start += 3) {
        if (stop()) return null;
        const result = await firstSuccess(instances.slice(start, start + 3), makeRequest, stop);
        if (result) return result;
    }
    return null;
}

/* ---------- picking the right video ---------- */

function pickBestVideo(results, track) {
    const artistMain = track.artist.toLowerCase().split(/,|&| feat\.? | ft\.? | x /)[0].trim();
    const cleanTitle = track.title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").trim();
    const wantedTitle = track.title.toLowerCase();
    const badWords = ["live","cover","remix","karaoke","reaction","slowed","sped up","speed up","nightcore","instrumental","8d","tutorial","lesson","mashup","bass boosted","reverb"];

    let best = null;

    for (const video of results) {
        if (video.type && video.type !== "video") continue;
        if (!video.videoId || video.liveNow || video.isUpcoming) continue;

        const length = Number(video.lengthSeconds) || 0;
        const title = (video.title || "").toLowerCase();
        const author = (video.author || "").toLowerCase();

        let score = 0;
        let matched = false;

        if (track.hasDuration) {
            const difference = Math.abs(length - track.duration);
            if (difference <= 3) score += 60;
            else if (difference <= 8) score += 45;
            else if (difference <= 15) score += 25;
            else if (difference <= 30) score += 5;
            else score -= 60;
        } else if (length > 600) {
            score -= 40;
        }

        if (author.endsWith("- topic")) score += 30;
        if (video.fromMusic) score += 15;

        if (artistMain && (author.includes(artistMain) || title.includes(artistMain))) { score += 20; matched = true; }
        if (cleanTitle && title.includes(cleanTitle)) { score += 25; matched = true; }

        for (const word of badWords) {
            const pattern = new RegExp("\\b" + word + "\\b");
            if (pattern.test(title) && !pattern.test(wantedTitle)) score -= 40;
        }

        if (!matched) continue;
        if (!best || score > best.score) best = { videoId: video.videoId, score };
    }

    return best && best.score >= 20 ? best : null;
}

/* ---------- provider 1: YouTube Music (Piped) ---------- */

async function pipedFindId(track, stop) {
    const instances = await getPipedInstances();
    const query = `${track.artist} ${track.title}`;

    const result = await tryBatches(
        instances,
        (instance, signal) =>
            fetchJson(`${instance}/search?q=${encodeURIComponent(query)}&filter=music_songs`, signal)
                .then(data => {
                    const items = (data.items || [])
                        .map(item => {
                            const match = String(item.url || "").match(/[?&]v=([\w-]{11})/);
                            return match && {
                                type: "video",
                                videoId: match[1],
                                title: item.title,
                                author: item.uploaderName,
                                lengthSeconds: item.duration,
                                fromMusic: true
                            };
                        })
                        .filter(Boolean);
                    if (!items.length) throw new Error("No results");
                    return items;
                }),
        stop
    );

    if (!result) return "";
    const best = pickBestVideo(result.data, track);
    return best ? best.videoId : "";
}

function pipedFormatsInOrder(info) {
    if (!info || info.error) return [];
    const formats = (info.audioStreams || []).filter(format => format && format.url && !format.videoOnly);

    const canPlayOpus = !!document.createElement("audio").canPlayType('audio/webm; codecs="opus"');
    const isMp4 = format => /mp4|m4a|aac/i.test(`${format.mimeType} ${format.format}`);
    const rank = format => (isMp4(format) ? 0 : canPlayOpus ? 1 : 9);

    return formats
        .filter(format => rank(format) < 9)
        .sort((a, b) => rank(a) - rank(b) || (b.bitrate || 0) - (a.bitrate || 0));
}

async function pipedCandidates(track, stop, fresh) {
    let videoId = fresh ? "" : getSavedVideoId(track.trackId);

    if (!videoId) {
        videoId = await pipedFindId(track, stop);
        if (!videoId || stop()) return [];
        saveVideoId(track.trackId, videoId, fresh);
    }

    const instances = await getPipedInstances();
    const result = await tryBatches(
        instances,
        (instance, signal) =>
            fetchJson(`${instance}/streams/${videoId}`, signal)
                .then(info => {
                    if (!pipedFormatsInOrder(info).length) throw new Error("No audio streams");
                    return info;
                }),
        stop
    );

    if (!result) return [];
    return pipedFormatsInOrder(result.data).slice(0, 2).map(format => ({
        url: format.url,
        instance: result.instance,
        saveKey: "musify-fast-piped"
    }));
}

/* ---------- provider 2: YouTube (Invidious) ---------- */

async function invidiousFindId(track, stop) {
    const instances = await getInstances();
    const query = `${track.artist} - ${track.title} audio`;

    const result = await tryBatches(
        instances,
        (instance, signal) =>
            fetchJson(`${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, signal)
                .then(data => {
                    if (!Array.isArray(data) || !data.length) throw new Error("No results");
                    return data;
                }),
        stop
    );

    if (!result) return "";
    const best = pickBestVideo(result.data, track);
    return best ? best.videoId : "";
}

function audioFormatsInOrder(info) {
    const formats = (info.adaptiveFormats || []).filter(
        format => format && format.url && String(format.type).startsWith("audio")
    );

    const canPlayOpus = !!document.createElement("audio").canPlayType('audio/webm; codecs="opus"');
    const order = canPlayOpus ? [140, 251, 139, 250, 249] : [140, 139];
    const picked = [];

    for (const itag of order) {
        const match =
            formats.find(format => {
                try { return new URL(format.url).searchParams.get("itag") === String(itag); }
                catch { return false; }
            }) || formats.find(format => String(format.itag) === String(itag));

        if (match && !picked.includes(match)) picked.push(match);
    }

    return picked.length ? picked : formats;
}

async function invidiousCandidates(track, stop, fresh) {
    let videoId = fresh ? "" : getSavedVideoId(track.trackId);

    if (!videoId) {
        videoId = await invidiousFindId(track, stop);
        if (!videoId || stop()) return [];
        saveVideoId(track.trackId, videoId, fresh);
    }

    const instances = await getInstances();
    const result = await tryBatches(
        instances,
        (instance, signal) =>
            fetchJson(`${instance}/api/v1/videos/${videoId}?local=true`, signal)
                .then(info => {
                    if (!audioFormatsInOrder(info).length) throw new Error("No audio streams");
                    return info;
                }),
        stop
    );

    if (!result) return [];

    const out = [];
    for (const format of audioFormatsInOrder(result.data).slice(0, 2)) {
        let origin = "";
        try { origin = new URL(format.url).origin; } catch { continue; }

        [...new Set([format.url, format.url.replace(origin, result.instance)])].forEach(url => {
            out.push({ url, instance: result.instance, saveKey: "musify-fast-source" });
        });
    }
    return out;
}

/* looks the song up ahead of time so the next track starts instantly */
async function prefetchNext() {
    if (shuffleEnabled || !currentQueue.length) return;

    const next = currentQueue[currentIndex + 1] || (repeatEnabled ? currentQueue[0] : null);
    if (!next || next.trackId === (currentTrack && currentTrack.trackId) || getSavedVideoId(next.trackId)) return;

    const never = () => false;
    try {
        const videoId = await Promise.any([
            pipedFindId(next, never).then(id => { if (!id) throw 0; return id; }),
            invidiousFindId(next, never).then(id => { if (!id) throw 0; return id; })
        ]);
        saveVideoId(next.trackId, videoId);
    } catch {}
}

/* ---------- playing it ---------- */

function probeAudio(url, isCancelled) {
    return new Promise((resolve, reject) => {
        const myProbe = ++probeCounter;
        let finished = false;
        let timer = null;
        let watcher = null;

        probing = true;

        const cleanup = () => {
            finished = true;
            clearTimeout(timer);
            clearInterval(watcher);
            audio.removeEventListener("canplay", onReady);
            audio.removeEventListener("error", onFail);
            if (probeCounter === myProbe) probing = false;
        };

        const onReady = () => { if (finished) return; cleanup(); resolve(); };
        const onFail = () => { if (finished) return; cleanup(); reject(new Error("Audio failed to load")); };

        timer = setTimeout(() => {
            if (finished) return;
            cleanup();
            reject(new Error("Audio timed out"));
        }, 8000);

        watcher = setInterval(() => {
            if (!finished && isCancelled()) { cleanup(); reject(new Error("cancelled")); }
        }, 150);

        audio.addEventListener("canplay", onReady);
        audio.addEventListener("error", onFail);

        audio.loop = false;
        audio.preload = "auto";
        audio.src = url;
        audio.load();
    });
}

/* YouTube Music and YouTube are searched at the same time; whichever gives playable audio first wins */
async function startFullPlayback(track, token, options = {}) {
    const isCancelled = () => token !== playToken;

    setNote(options.resumeAt ? "Reconnecting…" : "Finding song…");

    let winner = null;
    let chain = Promise.resolve();
    const stop = () => isCancelled() || !!winner;

    const providers = [
        { name: "YouTube Music", run: () => pipedCandidates(track, stop, options.fresh) },
        { name: "YouTube", run: () => invidiousCandidates(track, stop, options.fresh) }
    ];

    /* the player has one audio element, so playable-check runs one candidate list at a time */
    const jobs = providers.map(provider =>
        provider.run().catch(() => []).then(candidates => {
            if (!candidates.length || stop()) return;

            chain = chain.then(async () => {
                for (const candidate of candidates) {
                    if (stop()) return;
                    try {
                        await probeAudio(candidate.url, isCancelled);
                        winner = { ...candidate, source: provider.name };
                        return;
                    } catch {
                        if (isCancelled()) return;
                    }
                }
            });
            return chain;
        })
    );

    await Promise.all(jobs);

    if (isCancelled()) return "cancelled";
    if (!winner) return "failed";

    audioMode = "full";
    safeSet(winner.saveKey, winner.instance);

    if (options.resumeAt > 1) {
        try { audio.currentTime = options.resumeAt; } catch {}
    }

    setNote("");
    beginPlayback(track, token);
    prefetchNext();
    return "full";
}

function playPreview(track, token, reason) {
    if (token !== playToken) return;

    if (!track.previewUrl) {
        audioMode = "none";
        audio.pause();
        audio.removeAttribute("src");
        setNote("Couldn't find this song");
        setTitle(null);
        updatePlayButton();
        return;
    }

    audioMode = "preview";
    setNote((reason ? reason + " · " : "") + "30s preview");

    audio.loop = false;
    audio.preload = "auto";
    audio.src = track.previewUrl;
    audio.load();

    beginPlayback(track, token);
}

/* the stream dropped halfway through: get a fresh link and carry on from the same second */
function recoverStream(track, token) {
    const resumeAt = audio.currentTime || 0;
    audioMode = "none";
    updatePlayButton();

    startFullPlayback(track, token, { resumeAt, fresh: true }).then(result => {
        if (token !== playToken) return;
        if (result === "failed") playPreview(track, token, "Stream interrupted");
    }).catch(() => {
        if (token !== playToken) return;
        playPreview(track, token, "Stream interrupted");
    });
}

function beginPlayback(track, token) {
    audio.play().then(() => {
        if (token !== playToken) return;
        updatePlayButton();
        setTitle(track);
        updateMediaSession(track);
    }).catch(error => {
        if (token !== playToken) return;
        updatePlayButton();

        if (error && error.name === "NotAllowedError") {
            setNote("Press play to start");
        } else {
            setNote("Unable to play this song");
            setTitle(null);
        }
    });
}

/* ---------- MOBILE AUDIO SUPPORT ----------
   Phones only let a page start audio from a tap. Our song lookup is async, so on the first tap
   we play a silent clip to "unlock" the audio element; later songs can then start on their own. */

let audioUnlocked = false;
let silentUrl = null;

function makeSilentWav() {
    const rate = 8000, samples = rate / 2;
    const buffer = new ArrayBuffer(44 + samples);
    const view = new DataView(buffer);
    const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };

    write(0, "RIFF"); view.setUint32(4, 36 + samples, true); write(8, "WAVE");
    write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    write(36, "data"); view.setUint32(40, samples, true);
    for (let i = 0; i < samples; i++) view.setUint8(44 + i, 128);

    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
        if (!silentUrl) silentUrl = makeSilentWav();
        audio.loop = true;
        audio.src = silentUrl;
        audio.play().catch(() => {});
    } catch {}
}

/* lock screen / notification controls */
function updateMediaSession(track) {
    if (!("mediaSession" in navigator)) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: getArtist(track),
            album: track.album,
            artwork: track.artwork ? [{ src: track.artwork, sizes: "600x600", type: "image/jpeg" }] : []
        });
    } catch {}
}

if ("mediaSession" in navigator) {
    const handle = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
    handle("play", () => audio.play().catch(() => {}));
    handle("pause", () => audio.pause());
    handle("nexttrack", () => nextTrack());
    handle("previoustrack", () => previousTrack());
}

/* ---------- PLAYBACK ---------- */

function playTrack(track, queue = currentQueue, index = -1) {
    if (!track) return;

    const token = ++playToken;

    currentTrack = track;
    currentQueue = queue || [track];

    currentIndex = index >= 0 ? index : currentQueue.findIndex(item => item.trackId === track.trackId);
    if (currentIndex < 0) currentIndex = 0;

    document.getElementById("trackTitle").textContent = track.title;
    setNote("");
    setTitle(track);

    const artwork = getArtwork(track);
    const cover = document.getElementById("playerCover");

    cover.innerHTML = artwork
        ? `<img src="${artwork}" alt="" referrerpolicy="no-referrer">`
        : '<i class="fa-solid fa-music"></i>';

    const playerImage = cover.querySelector("img");
    if (playerImage) {
        playerImage.onerror = () => { cover.innerHTML = '<i class="fa-solid fa-music"></i>'; };
    }

    document.getElementById("playButton").disabled = false;
    document.getElementById("playerAddButton").disabled = false;
    document.getElementById("previousButton").disabled = currentQueue.length < 2;
    document.getElementById("nextButton").disabled = currentQueue.length < 2;

    document.getElementById("currentTime").textContent = "0:00";
    document.getElementById("duration").textContent = formatTime(track.hasDuration ? track.duration : 0);
    document.getElementById("progressFill").style.width = "0%";

    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audioMode = "none";
    unlockAudio();
    updatePlayButton();

    startFullPlayback(track, token).then(result => {
        if (token !== playToken) return;
        if (result === "failed") playPreview(track, token, "Full song unavailable");
    }).catch(() => {
        if (token !== playToken) return;
        playPreview(track, token, "Full song unavailable");
    });
}

function updatePlayButton() {
    const playing = !audio.paused && !audio.ended;
    document.getElementById("playButton").innerHTML = playing
        ? '<i class="fa-solid fa-pause"></i>'
        : '<i class="fa-solid fa-play"></i>';
    document.getElementById("playButton").title = playing ? "Pause" : "Play";
}

document.getElementById("playerAddButton").onclick = () => openPicker(currentTrack);

document.getElementById("playButton").onclick = () => {
    if (!currentTrack) return;

    if (!audio.getAttribute("src") || audioMode === "none") {
        if (!audio.getAttribute("src") || audio.paused) {
            playTrack(currentTrack, currentQueue, currentIndex);
        }
        return;
    }

    if (audio.paused) {
        audio.play().then(updatePlayButton).catch(() => setNote("Unable to resume playback"));
    } else {
        audio.pause();
    }
};

audio.addEventListener("play", () => {
    updatePlayButton();
    /* Keeps the tab title right when playback restarts after it ended */
    if (currentTrack && !probing && audioMode !== "none") setTitle(currentTrack);
});
audio.addEventListener("pause", updatePlayButton);
audio.addEventListener("waiting", () => { if (audioMode === "full" && !probing) setNote("Buffering…"); });
audio.addEventListener("playing", () => { if (audioMode === "full" && !probing) setNote(""); });

audio.addEventListener("timeupdate", () => {
    if (!currentTrack || probing || audioMode === "none") return;

    const current = audio.currentTime;
    const duration = Number.isFinite(audio.duration) ? audio.duration : (currentTrack.duration || 0);

    document.getElementById("currentTime").textContent = formatTime(current);
    document.getElementById("duration").textContent = formatTime(duration);
    document.getElementById("progressFill").style.width = duration ? `${(current / duration) * 100}%` : "0%";
});

audio.addEventListener("ended", () => {
    if (audioMode === "none") return;

    if (repeatEnabled && currentQueue.length < 2) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
    } else {
        nextTrack();
    }
});

audio.addEventListener("error", () => {
    if (!currentTrack || probing) return;
    if (!audio.getAttribute("src")) return;

    if (audioMode === "full") {
        /* first drop: reconnect and resume from the same second; second drop: 30s preview */
        if (recoveredToken !== playToken) {
            recoveredToken = playToken;
            recoverStream(currentTrack, playToken);
            return;
        }
        if (currentTrack.previewUrl) {
            playPreview(currentTrack, playToken, "Stream interrupted");
            return;
        }
    }

    setNote("This song is unavailable");
    setTitle(null);
    updatePlayButton();
});

function nextTrack() {
    if (!currentQueue.length) return;

    if (shuffleEnabled) {
        let next = Math.floor(Math.random() * currentQueue.length);
        if (currentQueue.length > 1 && next === currentIndex) next = (next + 1) % currentQueue.length;
        currentIndex = next;
    } else {
        currentIndex++;

        if (currentIndex >= currentQueue.length) {
            if (repeatEnabled) {
                currentIndex = 0;
            } else {
                /* End of the queue: playback stops, so the tab title resets */
                currentIndex = currentQueue.length - 1;
                audio.pause();
                audio.currentTime = 0;
                updatePlayButton();
                setTitle(null);
                return;
            }
        }
    }

    playTrack(currentQueue[currentIndex], currentQueue, currentIndex);
}

function previousTrack() {
    if (!currentQueue.length) return;

    if (audio.currentTime > 3) { audio.currentTime = 0; return; }

    currentIndex--;
    if (currentIndex < 0) currentIndex = repeatEnabled ? currentQueue.length - 1 : 0;

    playTrack(currentQueue[currentIndex], currentQueue, currentIndex);
}

document.getElementById("nextButton").onclick = nextTrack;
document.getElementById("previousButton").onclick = previousTrack;

/* ---------- PROGRESS ---------- */

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60);
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

document.getElementById("progressBar").onclick = event => {
    if (!currentTrack || !Number.isFinite(audio.duration)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const percentage = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    audio.currentTime = percentage * audio.duration;
};

/* ---------- SHUFFLE AND REPEAT ---------- */

const shuffleButton = document.getElementById("shuffleButton");
const repeatButton = document.getElementById("repeatButton");

function setShuffle(value) {
    shuffleEnabled = value;
    shuffleButton.classList.toggle("selected", shuffleEnabled);
    shuffleButton.title = shuffleEnabled ? "Shuffle on" : "Shuffle off";
    document.querySelectorAll(".pl-shuffle").forEach(button => button.classList.toggle("selected", shuffleEnabled));
}

shuffleButton.onclick = () => setShuffle(!shuffleEnabled);

repeatButton.onclick = () => {
    repeatEnabled = !repeatEnabled;
    repeatButton.classList.toggle("selected", repeatEnabled);
    repeatButton.title = repeatEnabled ? "Repeat on" : "Repeat off";
};

function resetPlayback() {
    setShuffle(false);
    repeatEnabled = false;
    repeatButton.classList.remove("selected");
    shuffleButton.title = "Shuffle";
    repeatButton.title = "Repeat";
}

/* ---------- LIKED SONGS ---------- */

function toggleLike(track) {
    const existing = likedTracks.findIndex(item => item.trackId === track.trackId);

    if (existing >= 0) likedTracks.splice(existing, 1);
    else likedTracks.push({ ...track, addedAt: Date.now() });

    safeSet("musify-liked", likedTracks);
    refreshLibraryViews();

    document.querySelectorAll(".track-card").forEach(card => {
        const button = card.querySelector(".card-heart");
        if (!button) return;

        const title = card.querySelector("h3")?.textContent;
        const artist = card.querySelector("p")?.textContent;

        if (title === track.title && artist === getArtist(track)) {
            const liked = isLiked(track);
            button.classList.toggle("liked", liked);
            button.innerHTML = `<i class="fa-${liked ? "solid" : "regular"} fa-heart"></i>`;
        }
    });
}

/* ---------- PANELS ---------- */

const overlay = document.getElementById("overlay");
const panelTitle = document.getElementById("panelTitle");
const panelBody = document.getElementById("panelBody");

function openPanel(type) {
    overlay.classList.add("open");

    if (type === "queue") {
        panelTitle.textContent = "Queue";

        if (!currentQueue.length) {
            panelBody.textContent = "Your queue is currently empty.";
            return;
        }

        panelBody.innerHTML = "";

        currentQueue.forEach((track, index) => {
            const item = document.createElement("div");
            item.className = "queue-item";
            if (index === currentIndex) item.classList.add("current");

            const artwork = getArtwork(track);

            item.innerHTML = `
                ${artwork ? `<img src="${artwork}" alt="" referrerpolicy="no-referrer">` : ""}
                <div><strong></strong><span></span></div>
            `;

            const queueImage = item.querySelector("img");
            if (queueImage) queueImage.onerror = () => queueImage.remove();

            item.querySelector("strong").textContent = track.title;
            item.querySelector("span").textContent = getArtist(track);

            item.onclick = () => { playTrack(track, currentQueue, index); closePanel(); };

            panelBody.appendChild(item);
        });
    }

    if (type === "lyrics") {
        panelTitle.textContent = "Lyrics";
        panelBody.textContent = "Lyrics are not available in this version of Musify.";
    }

    if (type === "volume") {
        panelTitle.textContent = "Volume";
        panelBody.innerHTML = `
            <p>Playback volume</p>
            <input class="volume-control" type="range" min="0" max="100" value="${volume}" id="volumeSlider">
            <p id="volumeValue">${volume}%</p>
        `;
        document.getElementById("volumeSlider").oninput = event => {
            volume = Number(event.target.value);
            audio.volume = volume / 100;
            document.getElementById("volumeValue").textContent = volume + "%";
        };
    }

    if (type === "cookies") {
        panelTitle.textContent = "Cookie preferences";
        panelBody.innerHTML = "";

        panelBody.appendChild(el("p", "dialog-sub",
            "Musify uses a cookie to remember this choice, and your browser's local storage to keep your playlists, playlist covers and liked songs on this device. Nothing is sent to a server by Musify."));
        panelBody.appendChild(el("p", "dialog-sub",
            "If you decline, anything already saved is deleted and your library only lasts until you refresh the page."));

        const actions = el("div", "panel-actions");
        const accept = el("button", "btn" + (consent === "accepted" ? " selected" : ""), "Accept");
        const decline = el("button", "btn" + (consent === "declined" ? " selected" : ""), "Decline");

        accept.onclick = () => { setConsent("accepted"); closePanel(); showToast("Saving turned on"); };
        decline.onclick = () => { setConsent("declined"); closePanel(); showToast("Saving turned off"); };

        actions.appendChild(accept);
        actions.appendChild(decline);
        panelBody.appendChild(actions);
    }

    if (type === "about") {
        panelTitle.textContent = "About Musify";
        panelBody.textContent =
            "Musify uses Apple music metadata and artwork. Full songs stream as YouTube Music audio (or regular YouTube audio) through public mirror servers, and only fall back to 30 second Apple previews when neither works.";
    }
}

function closePanel(event) {
    if (event && event.target !== overlay) return;
    overlay.classList.remove("open");
}

document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        /* Close only the top-most layer */
        if (dialogOverlay.classList.contains("open")) closeDialog();
        else closePanel();
    }

    if (
        event.code === "Space" &&
        !["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName) &&
        !dialogOverlay.classList.contains("open")
    ) {
        event.preventDefault();
        if (currentTrack) document.getElementById("playButton").click();
    }
});

/* ---------- INITIALIZATION ---------- */

updateNavigation();
updateCookieStatus();
updateNameStatus();
if (consent === null) document.getElementById("cookieBanner").classList.add("show");
loadTrending();
