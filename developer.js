/* Musify Developer dashboard: /Musify/Developer
   Only the owner account can open it. Loads after auth.js and settings.js.

   Live numbers come from Firebase:
     usernames/*                       -> number of accounts
     presence/<uid>/<connection>       -> who has Musify open right now (written by every signed-in tab)
     stats/daily/<YYYY-MM-DD>/plays    -> songs listened to that day, all accounts (counted from now on)
   Hiding the page is not security by itself: the Firebase rules shown on the page are what keep the numbers private. */
(() => {
const OWNER_EMAIL = "sawkrause@gmail.com";
const TIMEZONE = "America/Chicago";          /* "today" is counted in this timezone */

const auth = window.musifyAuth;
const db = window.musifyDatabase;
const $ = id => document.getElementById(id);

const dayKey = (date = new Date()) => date.toLocaleDateString("en-CA", { timeZone: TIMEZONE });

let user = null;
let authKnown = false;
const isOwner = () => !!(user && user.email && user.email.toLowerCase() === OWNER_EMAIL);

/* ============================================================
   Every signed-in tab: presence + songs-played counter
   ============================================================ */

let connRef = null;

function stopPresence() {
    if (!connRef) return;
    try { connRef.onDisconnect().cancel(); connRef.remove(); } catch {}
    connRef = null;
}

function startPresence() {
    stopPresence();
    if (!user) return;
    try {
        connRef = db.ref(`presence/${user.uid}`).push();
        const ref = connRef;
        ref.onDisconnect().remove()
            .then(() => ref.set(firebase.database.ServerValue.TIMESTAMP))
            .catch(() => {});        /* no rules yet: the dashboard explains what to add */
    } catch {}
}

db.ref(".info/connected").on("value", snap => { if (snap.val()) startPresence(); });

/* plus.js calls this each time a song has been listened to for 15 seconds */
window.musifyOnPlay = () => {
    if (!user) return;
    try {
        db.ref(`stats/daily/${dayKey()}/plays`)
            .transaction(value => (value || 0) + 1)
            .catch(() => {});
    } catch {}
};

/* ============================================================
   Dashboard
   ============================================================ */

const RULES = `// Add these inside the top-level "rules": { ... } in Firebase > Realtime Database > Rules.
// Keep everything you already have. If "usernames" already exists, just add the ".read" line to it.
"usernames": {
  ".read": "auth != null && auth.token.email === '${OWNER_EMAIL}'"
},
"presence": {
  ".read": "auth != null && auth.token.email === '${OWNER_EMAIL}'",
  "$uid": { "$conn": { ".write": "auth != null && auth.uid === $uid" } }
},
"stats": {
  ".read": "auth != null && auth.token.email === '${OWNER_EMAIL}'",
  "daily": { "$day": { "plays": {
    ".write": "auth != null",
    ".validate": "newData.isNumber() && ((!data.exists() && newData.val() === 1) || newData.val() === data.val() + 1)"
  } } }
}`;

const listeners = [];      /* firebase listeners to detach when leaving the page */
let timers = [];
let view = null;
const refs = {};

function detach() {
    listeners.splice(0).forEach(([ref, fn]) => { try { ref.off("value", fn); } catch {} });
    timers.forEach(clearInterval);
    timers = [];
}

function card(label, sub) {
    const box = el("div", "dev-card");
    box.appendChild(el("div", "dev-label", label));
    const number = el("div", "dev-num", "…");
    box.appendChild(number);
    const note = el("div", "dev-sub", sub || "");
    box.appendChild(note);
    return { box, number, note };
}

function row(title, sub, right) {
    const r = el("div", "setting-row");
    const left = el("div");
    left.appendChild(el("h3", "", title));
    if (sub) { const p = el("p", "", sub); left.appendChild(p); r.__sub = p; }
    r.appendChild(left);
    if (right) r.appendChild(right);
    return r;
}

function pill(text, onclick) {
    const b = el("button", "st-pill", text);
    b.type = "button";
    b.onclick = onclick;
    return b;
}

function group(title) {
    const g = el("div", "st-group");
    g.appendChild(el("h2", "st-h", title));
    return g;
}

function permissionProblem(card_, what) {
    card_.number.textContent = "—";
    card_.note.textContent = `No permission to read ${what}. See “Database setup” below.`;
    card_.note.classList.add("err");
    refs.setup.open = true;
}

function render() {
    detach();
    view = $("developerView");
    view.innerHTML = "";

    const head = el("div", "dev-head");
    const titles = el("div");
    titles.appendChild(el("h1", "page-heading st-title", "Developer"));
    titles.appendChild(el("p", "page-subtitle", `Signed in as ${user.email}. Only you can see this page.`));
    head.appendChild(titles);
    refs.updated = el("span", "dev-updated", "");
    head.appendChild(refs.updated);
    view.appendChild(head);

    /* ---- live numbers ---- */
    const stats = el("div", "dev-stats");
    const accounts = card("Accounts", "Total registered");
    const online = card("Online now", "Signed in with Musify open");
    const today = card("Songs played today", `Counted in ${TIMEZONE.split("/")[1].replace("_", " ")} time`);
    [accounts, online, today].forEach(c => stats.appendChild(c.box));
    view.appendChild(stats);

    refs.setup = el("details", "dev-setup");

    const touch = () => { refs.updated.textContent = "Updated " + new Date().toLocaleTimeString(); };

    const watch = (ref, onValue, onError) => {
        const fn = snap => { onValue(snap); touch(); };
        ref.on("value", fn, onError);
        listeners.push([ref, fn]);
    };

    const loadAccounts = () => {
        db.ref("usernames").once("value").then(snap => {
            accounts.number.textContent = snap.numChildren().toLocaleString();
            accounts.note.textContent = "Total registered";
            accounts.note.classList.remove("err");
            touch();
        }).catch(() => permissionProblem(accounts, "usernames"));
    };
    loadAccounts();
    timers.push(setInterval(loadAccounts, 60000));

    watch(db.ref("presence"),
        snap => { online.number.textContent = snap.numChildren().toLocaleString(); online.note.classList.remove("err"); },
        () => permissionProblem(online, "presence"));

    watch(db.ref(`stats/daily/${dayKey()}/plays`),
        snap => { today.number.textContent = (snap.val() || 0).toLocaleString(); today.note.classList.remove("err"); },
        () => permissionProblem(today, "stats"));

    /* ---- last 7 days ---- */
    const week = group("Songs played, last 7 days");
    const bars = el("div", "dev-bars");
    week.appendChild(bars);
    view.appendChild(week);

    const days = Array.from({ length: 7 }, (_, i) => dayKey(new Date(Date.now() - (6 - i) * 864e5)));
    watch(db.ref("stats/daily").orderByKey().limitToLast(7), snap => {
        const data = snap.val() || {};
        const values = days.map(d => (data[d] && data[d].plays) || 0);
        const max = Math.max(...values, 1);
        bars.innerHTML = "";
        days.forEach((d, i) => {
            const col = el("div", "dev-bar");
            col.appendChild(el("span", "dev-bar-n", String(values[i])));
            const fill = el("div", "dev-bar-fill");
            fill.style.height = Math.max(2, (values[i] / max) * 100) + "%";
            col.appendChild(fill);
            col.appendChild(el("span", "dev-bar-d", d.slice(5)));
            bars.appendChild(col);
        });
    }, () => { bars.textContent = "No permission to read stats. See “Database setup” below."; });

    /* ---- music sources ---- */
    const sources = group("Music sources");
    const list = el("div", "dev-list");
    const test = pill("Test servers", () => testServers(list, test));
    sources.appendChild(row("Server health", "Checks the YouTube Music and YouTube servers Musify uses for full songs.", test));
    sources.appendChild(list);
    view.appendChild(sources);

    /* ---- this device / now playing ---- */
    const dbg = group("This device");
    const rowTrack = row("Now playing", "", null);
    const rowMode = row("Audio source", "", null);
    const rowQueue = row("Queue", "", null);
    const rowCache = row("Songs remembered", "", null);
    [rowTrack, rowMode, rowQueue, rowCache].forEach(r => { r.appendChild(el("span", "dev-val", "")); dbg.appendChild(r); });
    view.appendChild(dbg);

    const MODES = { full: "Full song", preview: "30 second preview", none: "Idle" };
    const paintDebug = () => {
        const set = (r, text) => { r.querySelector(".dev-val").textContent = text; };
        set(rowTrack, currentTrack ? `${currentTrack.title} — ${currentTrack.artist}` : "Nothing");
        set(rowMode, MODES[audioMode] || audioMode);
        set(rowQueue, currentQueue.length ? `${currentIndex + 1} of ${currentQueue.length}` : "Empty");
        let known = 0;
        try { known = Object.keys(safeGet("musify-yt-ids", {})).length; } catch {}
        set(rowCache, String(Math.max(known, Object.keys(idMemo).length)));
    };
    paintDebug();
    timers.push(setInterval(() => { if (currentPage === "developer") paintDebug(); }, 1000));

    /* ---- tools ---- */
    const tools = group("Tools");
    tools.appendChild(row("Clear saved audio sources", "Forgets saved servers and song matches on this device.",
        pill("Clear", () => { resetAudioCache(); paintDebug(); showToast("Audio sources cleared"); })));
    tools.appendChild(row("Download library backup", "Your liked songs and playlists as a JSON file.",
        pill("Download", downloadBackup)));
    tools.appendChild(row("Copy debug info", "Browser, page and playback details to paste when something breaks.",
        pill("Copy", copyDebug)));
    tools.appendChild(row("Reload Musify", "Restart the site on this device.", pill("Reload", () => location.reload())));
    view.appendChild(tools);

    /* ---- setup ---- */
    refs.setup.appendChild(el("summary", "", "Database setup"));
    refs.setup.appendChild(el("p", "dev-help",
        "These numbers are stored in your Firebase Realtime Database. Add these rules so only you can read them and so every signed-in account can add to the song counter."));
    const code = el("pre", "dev-code", RULES);
    refs.setup.appendChild(code);
    refs.setup.appendChild(pill("Copy rules", () => copyText(RULES, "Rules copied")));
    const setupGroup = group("Setup");
    setupGroup.appendChild(refs.setup);
    view.appendChild(setupGroup);
}

/* ---------- server health ---------- */

async function ping(url, timeout = 6000) {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        return { ok: response.ok, ms: Math.round(performance.now() - started), status: response.status };
    } catch {
        return { ok: false, ms: Math.round(performance.now() - started), status: 0 };
    } finally { clearTimeout(timer); }
}

async function testServers(list, button) {
    button.disabled = true;
    button.textContent = "Testing…";
    list.innerHTML = "";

    const [piped, inv] = await Promise.all([getPipedInstances(), getInstances()]);
    const jobs = [
        ...piped.slice(0, 8).map(base => ({ kind: "YouTube Music", base, url: base + "/healthcheck" })),
        ...inv.slice(0, 8).map(base => ({ kind: "YouTube", base, url: base + "/api/v1/stats" }))
    ];

    const rows = jobs.map(job => {
        const r = el("div", "dev-server");
        r.appendChild(el("span", "dev-server-kind", job.kind));
        r.appendChild(el("span", "dev-server-name", job.base.replace(/^https?:\/\//, "")));
        const status = el("span", "dev-server-status", "testing…");
        r.appendChild(status);
        list.appendChild(r);
        return status;
    });

    await Promise.all(jobs.map(async (job, i) => {
        const result = await ping(job.url);
        rows[i].textContent = result.ok ? `OK · ${result.ms} ms` : (result.status ? `Error ${result.status}` : "No response");
        rows[i].className = "dev-server-status " + (result.ok ? "ok" : "bad");
    }));

    button.disabled = false;
    button.textContent = "Test again";
}

/* ---------- tools ---------- */

function copyText(text, message) {
    const done = () => showToast(message || "Copied");
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
}

function fallbackCopy(text, done) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); done(); } catch { showToast("Couldn't copy"); }
    area.remove();
}

function downloadBackup() {
    const data = { exportedAt: new Date().toISOString(), displayName, liked: likedTracks, playlists };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `musify-backup-${dayKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Backup downloaded");
}

function copyDebug() {
    const text = [
        `Musify debug · ${new Date().toISOString()}`,
        `Page: ${location.pathname}`,
        `Browser: ${navigator.userAgent}`,
        `Screen: ${innerWidth}x${innerHeight}`,
        `Playing: ${currentTrack ? currentTrack.title + " — " + currentTrack.artist : "nothing"}`,
        `Audio mode: ${audioMode}`,
        `Saved video id: ${currentTrack ? (getSavedVideoId(currentTrack.trackId) || "none") : "-"}`,
        `Queue: ${currentQueue.length} songs, position ${currentIndex + 1}`,
        `Playlists: ${playlists.length}, liked: ${likedTracks.length}`,
        `Saving to this device: ${consent}`
    ].join("\n");
    copyText(text, "Debug info copied");
}

/* ============================================================
   Access control + navigation
   ============================================================ */

function enter() {
    if (currentPage !== "developer") { detach(); return; }

    const box = $("developerView");
    if (!authKnown) { box.innerHTML = ""; box.appendChild(el("p", "profile-loading", "Checking access…")); return; }

    if (!isOwner()) { detach(); box.innerHTML = ""; navigate("home"); return; }
    render();
}

const _navigate = navigate;
navigate = function (...args) { _navigate(...args); enter(); addSettingsLink(); };
const _goToHistory = goToHistory;
goToHistory = function (...args) { _goToHistory(...args); enter(); };

/* owner-only shortcut inside Settings */
function addSettingsLink() {
    const body = document.querySelector("#settings .st-body");
    const existing = $("devLinkGroup");
    if (!body) return;
    if (!isOwner()) { if (existing) existing.remove(); return; }
    if (existing) return;

    const g = group("Developer");
    g.id = "devLinkGroup";
    g.appendChild(row("Developer dashboard", "Accounts, who’s online and songs played. Only visible to you.",
        pill("Open", () => navigate("developer"))));
    const groups = body.querySelectorAll(".st-group");
    body.insertBefore(g, groups[groups.length - 1]);      /* just above About */
}

auth.onAuthStateChanged(u => {
    user = u;
    authKnown = true;
    if (u) startPresence(); else stopPresence();
    addSettingsLink();
    enter();
});

enter();
})();
