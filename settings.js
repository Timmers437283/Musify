/* Musify Settings controls + playlist importer.
   Loads LAST (after auth.js). It only uses functions that already exist in app.js / plus.js:
   navigate, goToHistory, createPlaylist, savePlaylists, refreshLibraryViews, openPlaylist, showToast,
   normalizeAppleTrack, fetchJson, pipedFindId, invidiousFindId, saveVideoId, safeGet, safeSet,
   resetPlayback, resetAudioCache, countText.  Songs are matched to Apple metadata (the same data every
   other Musify song uses) and their full-song audio is looked up with the existing YouTube Music / YouTube
   sources, so imported songs play exactly like any other song. */
(() => {
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ============================================================
   Page flag (used to style the modals opened from Settings)
   ============================================================ */

function syncPage() {
    document.body.dataset.page = currentPage;
    if (currentPage === "settings") syncControls();
}

const _navigate = navigate;
navigate = function (...args) { _navigate(...args); syncPage(); };
const _goToHistory = goToHistory;
goToHistory = function (...args) { _goToHistory(...args); syncPage(); };

/* ============================================================
   Controls
   ============================================================ */

const appEl = document.querySelector(".app");

/* kept in memory so the toggles work even when saving to this device is turned off */
const display = {
    compact: !!safeGet("musify-compact", false),
    right: safeGet("musify-show-right", true) !== false
};

function applyDisplay() {
    document.body.classList.toggle("compact-lib", display.compact);
    appEl.classList.toggle("no-right", !display.right);
}

function syncControls() {
    $("stVolume").value = volume;
    $("stVolumeValue").textContent = volume + "%";
    $("stCompact").checked = display.compact;
    $("stNowPlaying").checked = display.right;
}

$("stVolume").addEventListener("input", event => {
    volume = Number(event.target.value);
    audio.volume = volume / 100;
    $("stVolumeValue").textContent = volume + "%";
});

$("stCompact").addEventListener("change", event => {
    display.compact = event.target.checked;
    safeSet("musify-compact", display.compact);
    applyDisplay();
});

$("stNowPlaying").addEventListener("change", event => {
    display.right = event.target.checked;
    safeSet("musify-show-right", display.right);
    applyDisplay();
});

$("stResetPlayback").onclick = () => { resetPlayback(); showToast("Shuffle and repeat reset"); };
$("stResetAudio").onclick = () => { resetAudioCache(); showToast("Saved audio sources cleared"); };

$("stGoImport").onclick = () => {
    $("importSection").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => $("impInput").focus({ preventScroll: true }), 350);
};

/* ============================================================
   Importer: reading the input
   ============================================================ */

const MAX_SONGS = 500;

const imp = {
    token: 0,          /* bumps whenever the input changes or Cancel is pressed; stops old work */
    items: [],         /* [{ label, query, title, artist }] in the original order */
    matches: [],       /* Musify track objects (or null) in the same order */
    name: "",
    filename: "",
    sourceNote: "",
    imported: false
};

const ui = {
    input: $("impInput"), name: $("impName"), nameRow: $("impNameRow"), btn: $("impBtn"),
    badge: $("impBadge"), preview: $("impPreview"), message: $("impMessage"),
    progress: $("impProgress"), bar: $("impBarFill"), status: $("impStatus"),
    unmatched: $("impUnmatched"), unmatchedTitle: $("impUnmatchedTitle"), unmatchedList: $("impUnmatchedList")
};

/* "Song (feat. X) - 2011 Remaster" -> "Song" */
function cleanTitle(text) {
    return String(text || "")
        .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "")
        .replace(/\s+-\s+(remaster(ed)?|live|single version|radio edit|mono|stereo|\d{4}\b).*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
}

const looksLikeTime = s => /^\d{1,2}:\d{2}$/.test(s);
const looksLikeIndex = s => /^\d{1,4}$/.test(s);

/* quote-aware CSV / TSV parser */
function parseCsv(text) {
    const first = text.split(/\r?\n/, 1)[0] || "";
    const delimiter = [",", ";", "\t"].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];

    const rows = [];
    let row = [], cell = "", quoted = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; }
                else quoted = false;
            } else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === delimiter) { row.push(cell); cell = ""; }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(cell); cell = "";
            if (row.some(x => x.trim())) rows.push(row);
            row = [];
        } else cell += c;
    }
    row.push(cell);
    if (row.some(x => x.trim())) rows.push(row);
    return rows;
}

function itemsFromCsv(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) return null;

    const header = rows[0].map(h => h.trim().toLowerCase());
    const bad = /artist|album|uri|id\b|date|duration|number|popularity|genre|label|added/;
    let titleAt = header.findIndex(h => /(track|song|title)/.test(h) && !bad.test(h));
    if (titleAt < 0) titleAt = header.findIndex(h => h === "name");
    const artistAt = header.findIndex(h => /artist/.test(h));
    if (titleAt < 0) return null;

    return rows.slice(1).map(r => {
        const title = (r[titleAt] || "").trim();
        const artist = artistAt >= 0 ? (r[artistAt] || "").split(/[;,]/)[0].trim() : "";
        return title ? { label: artist ? `${title} — ${artist}` : title, title, artist } : null;
    }).filter(Boolean);
}

/* text copied out of Spotify arrives as: index, title, [E], artist, album, date, duration ... */
function itemsFromSpotifyCopy(lines) {
    const items = [];
    for (let i = 0; i < lines.length; i++) {
        if (!looksLikeIndex(lines[i]) || !lines[i + 1] || looksLikeTime(lines[i + 1]) || looksLikeIndex(lines[i + 1])) continue;
        let j = i + 1;
        const title = lines[j++];
        if (lines[j] === "E") j++;
        const artist = lines[j] && !looksLikeIndex(lines[j]) && !looksLikeTime(lines[j]) ? lines[j] : "";
        items.push({ label: artist ? `${title} — ${artist}` : title, title, artist });
        i = j;
    }
    return items;
}

function itemsFromLines(text) {
    const lines = text.split(/\r?\n/).map(l => l.replace(/\t+/g, " ").trim()).filter(Boolean);
    if (!lines.length) return [];

    const noisy = lines.filter(l => looksLikeIndex(l) || looksLikeTime(l)).length;
    if (noisy / lines.length >= 0.3) {
        const items = itemsFromSpotifyCopy(lines);
        if (items.length >= 3) return items;
    }

    return lines
        .map(l => l.replace(/^\s*\d{1,4}\s*[\.\)\-:]\s+/, "").replace(/\s+\d{1,2}:\d{2}$/, "").trim())
        .filter(l => l && !looksLikeTime(l) && !looksLikeIndex(l))
        .map(l => ({ label: l, query: l }));
}

/* ---------- Spotify links ----------
   Spotify doesn't let a website read a playlist directly, so the public embed page is fetched through a
   CORS helper and its song list is read. Embeds only share the first 100 songs. */

const SPOTIFY_ID = /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/|spotify:playlist:)([A-Za-z0-9]+)/;

const PROXIES = [
    url => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
    url => "https://corsproxy.io/?" + encodeURIComponent(url),
    url => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url)
];

function extractSpotifyTracks(data) {
    let name = "";
    let items = [];

    (function walk(node, depth) {
        if (!node || typeof node !== "object" || items.length || depth > 14) return;

        if (Array.isArray(node)) {
            const songs = node.filter(x => x && typeof x.title === "string" && typeof x.subtitle === "string");
            if (songs.length && songs.length === node.length) {
                items = songs.map(x => {
                    const artist = x.subtitle.split(/,| /)[0].trim();
                    return { label: `${x.title} — ${x.subtitle}`, title: x.title, artist };
                });
                return;
            }
            node.forEach(x => walk(x, depth + 1));
            return;
        }

        if (!name && typeof node.name === "string" && (node.type === "playlist" || node.trackList)) name = node.name;
        Object.values(node).forEach(v => walk(v, depth + 1));
    })(data, 0);

    return { name, items };
}

async function readSpotifyPlaylist(id, token) {
    const page = `https://open.spotify.com/embed/playlist/${id}`;

    for (const makeUrl of PROXIES) {
        if (token !== imp.token) throw new Error("cancelled");
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 9000);
            const response = await fetch(makeUrl(page), { signal: controller.signal });
            clearTimeout(timer);
            if (!response.ok) continue;

            const html = await response.text();
            const found = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (!found) continue;

            const result = extractSpotifyTracks(JSON.parse(found[1]));
            if (result.items.length) return result;
        } catch {}
    }
    throw new Error("spotify");
}

const SPOTIFY_HELP =
    "Couldn’t read that Spotify link. Spotify doesn’t let other apps read playlists directly. " +
    "Open the playlist in Spotify, select all songs (Ctrl+A), copy, and paste them here instead, " +
    "or upload a CSV exported with a tool like Exportify.";

/* ============================================================
   Importer: matching
   ============================================================ */

const tokens = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").split(/[^\p{L}\p{N}]+/u)
    .filter(t => t && !["feat", "ft", "featuring", "remastered", "remaster"].includes(t));

async function appleSongSearch(term, token) {
    for (let attempt = 0; attempt < 3; attempt++) {
        if (token !== imp.token) throw new Error("cancelled");
        try {
            const data = await fetchJson(
                `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=8&country=US`
            );
            return (data.results || []).filter(r => r.wrapperType === "track");
        } catch {
            await sleep(900 * (attempt + 1));   /* Apple throttles bursts, so back off and retry */
        }
    }
    throw new Error("search failed");
}

async function matchItem(item, token) {
    const query = item.title
        ? `${cleanTitle(item.title)} ${item.artist || ""}`.trim()
        : cleanTitle(item.query) || item.query;

    const wanted = new Set(tokens(query));
    if (!wanted.size) return null;

    const wantedTitle = item.title ? tokens(cleanTitle(item.title)) : null;
    const results = await appleSongSearch(query, token);

    let best = null;
    for (const r of results) {
        const have = new Set(tokens(`${r.trackName} ${r.artistName}`));
        if (!have.size) continue;

        let hits = 0;
        wanted.forEach(t => { if (have.has(t)) hits++; });
        const score = (hits / wanted.size) * 0.8 + (hits / have.size) * 0.2;

        if (wantedTitle && wantedTitle.length) {
            const inTitle = new Set(tokens(r.trackName));
            const titleHits = wantedTitle.filter(t => inTitle.has(t)).length;
            if (titleHits / wantedTitle.length < 0.7) continue;
        }

        if (!best || score > best.score) best = { r, score };
    }

    return best && best.score >= 0.7 ? normalizeAppleTrack(best.r) : null;
}

/* the full-song lookup Musify uses when a song is played: YouTube Music and YouTube are asked together */
async function resolveFullSong(track, token) {
    if (getSavedVideoId(track.trackId)) return true;

    const deadline = Date.now() + 15000;
    const stop = () => token !== imp.token || Date.now() > deadline;

    try {
        const id = await Promise.any([
            pipedFindId(track, stop).then(v => { if (!v) throw 0; return v; }),
            invidiousFindId(track, stop).then(v => { if (!v) throw 0; return v; })
        ]);
        saveVideoId(track.trackId, id);
        return true;
    } catch { return false; }
}

/* runs `work` over the list with a few at a time; results keep the list's order */
async function pool(list, size, token, work, onStep) {
    const out = new Array(list.length).fill(null);
    let next = 0, done = 0;

    const worker = async () => {
        while (token === imp.token) {
            const i = next++;
            if (i >= list.length) return;
            try { out[i] = await work(list[i], i); } catch { out[i] = null; }
            if (token !== imp.token) return;
            onStep(++done);
        }
    };

    await Promise.all(Array.from({ length: size }, worker));
    return out;
}

/* ============================================================
   Importer: UI
   ============================================================ */

function setBadge(text, kind) {
    ui.badge.textContent = text;
    ui.badge.className = "st-badge" + (kind ? " " + kind : "");
}

function setProgress(text, fraction) {
    ui.progress.hidden = text === null;
    if (text !== null) {
        ui.status.textContent = text;
        ui.bar.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + "%";
    }
}

function showMessage(html, isError) {
    ui.message.hidden = !html;
    ui.message.className = "imp-message" + (isError ? " err" : "");
    ui.message.textContent = html || "";
}

function resetResults() {
    imp.items = [];
    imp.matches = [];
    imp.imported = false;
    ui.btn.disabled = true;
    ui.btn.textContent = "Import playlist";
    ui.unmatched.hidden = true;
    ui.unmatched.open = false;
    ui.unmatchedList.innerHTML = "";
    setProgress(null);
    showMessage("");
}

function autoGrow() {
    ui.input.style.height = "auto";
    ui.input.style.height = Math.min(ui.input.scrollHeight, 150) + "px";
}

function renderPreview(matched, total) {
    const missing = total - matched;
    ui.preview.textContent = `Preview: ${total} song${total === 1 ? "" : "s"} found · ${matched} matched · ${missing} unmatched`;

    ui.unmatched.hidden = missing === 0;
    if (missing) {
        ui.unmatchedTitle.textContent = `Show ${missing} unmatched song${missing === 1 ? "" : "s"}`;
        ui.unmatchedList.innerHTML = "";
        imp.items.forEach((item, i) => {
            if (imp.matches[i]) return;
            const li = document.createElement("li");
            li.textContent = item.label;
            ui.unmatchedList.appendChild(li);
        });
    }
}

async function analyze(file) {
    const token = ++imp.token;
    const text = ui.input.value.trim();

    resetResults();
    ui.nameRow.hidden = true;

    if (!text) {
        setBadge("Ready");
        ui.preview.textContent = "Paste a link or a list of songs to see a preview.";
        return;
    }

    setBadge("Reading", "busy");
    ui.preview.textContent = "Reading your songs…";

    let items = [];
    let name = "";

    try {
        const link = text.match(SPOTIFY_ID);

        if (link && !text.includes("\n")) {
            setProgress("Reading the Spotify playlist…", 0.05);
            const result = await readSpotifyPlaylist(link[1], token);
            items = result.items;
            name = result.name;
            if (items.length >= 100) {
                imp.sourceNote = "Spotify only shares the first 100 songs of a link. For a longer playlist, paste the song list or upload a CSV instead.";
            }
        } else if (/^https?:\/\//i.test(text) && !text.includes("\n")) {
            throw new Error("link");
        } else {
            const isCsv = (imp.filename && /\.csv$/i.test(imp.filename)) || /^[^\n]*(artist)[^\n]*(,|;|\t)/i.test(text.split("\n", 1)[0]) || /(,|;|\t)[^\n]*artist/i.test(text.split("\n", 1)[0]);
            items = (isCsv && itemsFromCsv(text)) || itemsFromLines(text);
            name = imp.filename ? imp.filename.replace(/\.[^.]+$/, "") : "";
        }
    } catch (error) {
        if (token !== imp.token) return;
        setProgress(null);
        setBadge("Problem", "err");
        ui.preview.textContent = "Nothing to preview yet.";
        showMessage(error.message === "link"
            ? "Only Spotify playlist links are supported. You can also paste a list of songs or upload a .txt or .csv file."
            : SPOTIFY_HELP, true);
        return;
    }

    if (token !== imp.token) return;

    if (!items.length) {
        setProgress(null);
        setBadge("Problem", "err");
        ui.preview.textContent = "Nothing to preview yet.";
        showMessage("No songs were found in that. Try one song per line, like “Song – Artist”.", true);
        return;
    }

    if (items.length > MAX_SONGS) {
        showMessage(`Only the first ${MAX_SONGS} songs will be imported.`);
        items = items.slice(0, MAX_SONGS);
    }

    imp.items = items;
    ui.name.value = (name || "Imported playlist").slice(0, 50);
    ui.nameRow.hidden = false;
    setBadge("Matching", "busy");
    ui.preview.textContent = `Preview: ${items.length} song${items.length === 1 ? "" : "s"} found · matching…`;
    if (imp.sourceNote) showMessage(imp.sourceNote);

    /* 1. find each song (order is kept) */
    setProgress(`Matching songs… 0 / ${items.length}`, 0);
    imp.matches = await pool(items, 3, token, (item) => matchItem(item, token),
        done => setProgress(`Matching songs… ${done} / ${items.length}`, done / items.length));
    if (token !== imp.token) return;

    const matched = imp.matches.filter(Boolean);
    renderPreview(matched.length, items.length);
    ui.btn.disabled = matched.length === 0;
    setBadge(matched.length ? "Ready" : "Problem", matched.length ? "" : "err");
    if (!matched.length) showMessage("None of those songs could be matched. Check the spelling, or try the “Song – Artist” format.", true);

    /* 2. look up their full-song audio in the background (this is what makes them start fast when played) */
    if (!matched.length) { setProgress(null); return; }

    let fails = 0, found = 0, gaveUp = false;
    setProgress(`Finding full-song audio… 0 / ${matched.length}`, 0);

    await pool(matched, 4, token, async track => {
        if (gaveUp) return false;
        const ok = await resolveFullSong(track, token);
        if (ok) { found++; fails = 0; }
        else if (++fails >= 6 && !found) gaveUp = true;   /* the music servers look down; stop wasting time */
        return ok;
    }, done => setProgress(`Finding full-song audio… ${done} / ${matched.length}`, done / matched.length));

    if (token !== imp.token) return;
    setProgress(null);

    if (gaveUp) {
        showMessage((imp.sourceNote ? imp.sourceNote + " " : "") +
            "The music servers are slow right now, so full-song lookups were skipped. Songs will be found when you play them.");
    }
}

/* ---------- creating the playlist ---------- */

ui.btn.onclick = () => {
    if (imp.imported) return;

    const seen = new Set();
    const tracks = [];
    imp.matches.forEach(track => {
        if (track && !seen.has(track.trackId)) { seen.add(track.trackId); tracks.push(track); }
    });
    if (!tracks.length) return;

    const name = (ui.name.value.trim() || "Imported playlist").slice(0, 50);
    const playlist = createPlaylist(name);
    const now = Date.now();
    tracks.forEach((track, i) => playlist.tracks.push({ ...track, addedAt: now + i }));
    savePlaylists();
    refreshLibraryViews();

    imp.imported = true;
    ui.btn.disabled = true;
    ui.btn.textContent = "Imported";
    setBadge("Done");
    showToast(`Imported ${tracks.length} songs into "${name}"`);

    ui.message.hidden = false;
    ui.message.className = "imp-message";
    ui.message.textContent = `Imported ${countText(tracks.length)} into “${name}”.`;
    const open = document.createElement("button");
    open.className = "st-link";
    open.type = "button";
    open.textContent = "Open playlist";
    open.onclick = () => openPlaylist(playlist.id);
    ui.message.appendChild(open);
};

/* ---------- wiring ---------- */

let typingTimer = null;

ui.input.addEventListener("input", () => {
    imp.filename = "";
    imp.sourceNote = "";
    autoGrow();
    clearTimeout(typingTimer);
    imp.token++;
    resetResults();
    ui.nameRow.hidden = true;

    const text = ui.input.value.trim();
    if (!text) { setBadge("Ready"); ui.preview.textContent = "Paste a link or a list of songs to see a preview."; return; }

    /* wait until typing stops (a pasted link or list starts straight away) */
    typingTimer = setTimeout(() => analyze(), 900);
});

ui.input.addEventListener("paste", () => {
    setTimeout(() => { clearTimeout(typingTimer); autoGrow(); analyze(); }, 30);
});

$("impFileBtn").onclick = () => $("impFile").click();

$("impFile").addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;

    if (!/\.(txt|csv)$/i.test(file.name) && !/^text\//.test(file.type)) {
        showMessage("Please choose a .txt or .csv file.", true);
        return;
    }

    try {
        const text = await file.text();
        imp.sourceNote = "";
        ui.input.value = text;
        autoGrow();
        imp.filename = file.name;
        clearTimeout(typingTimer);
        analyze();
    } catch { showMessage("Couldn’t read that file.", true); }
});

/* drag a .txt / .csv straight onto the box */
["dragover", "drop"].forEach(type => ui.input.addEventListener(type, event => {
    if (!event.dataTransfer || !event.dataTransfer.files.length) return;
    event.preventDefault();
    if (type === "drop") {
        const dt = new DataTransfer();
        dt.items.add(event.dataTransfer.files[0]);
        $("impFile").files = dt.files;
        $("impFile").dispatchEvent(new Event("change"));
    }
}));

$("impCancel").onclick = () => {
    imp.token++;
    setProgress(null);
    if (imp.matches.length) { setBadge("Ready"); return; }
    setBadge("Ready");
    ui.preview.textContent = "Cancelled. Paste a link or a list of songs to try again.";
};

/* ============================================================
   Start
   ============================================================ */

applyDisplay();
syncPage();
})();
