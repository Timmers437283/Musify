/* Musify accounts + cloud sync.
   Loads AFTER app.js and plus.js. It wraps safeSet/safeGet from app.js so every
   user-specific save goes to Firebase (users/<uid>/...) instead of localStorage.
   Cloud layout:
     users/<uid>/profile   username, displayName, createdAt
     users/<uid>/library   likedTracks, playlistOrder, playlists/<id>, covers/<id>
     users/<uid>/stats     secs, plays, since, tracks/<id>, artists/<key>, days/<date>
     users/<uid>/mixes     daily mixes cache
     users/<uid>/meta      migration status
     usernames/<lowercase> -> uid   (unique username claims) */
(() => {
"use strict";

const auth = window.musifyAuth;
const db = window.musifyDatabase;
const $ = id => document.getElementById(id);

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_NAME = "skiddlez23";
const LOCAL_KEYS = ["musify-liked", "musify-playlists", "musify-name", "musify-stats", "musify-mixes"];
const CLOUD_KEYS = new Set(LOCAL_KEYS);

const bridge = window.musifyStatsBridge || {
    get: () => ({ secs: 0, plays: 0, tracks: {}, artists: {}, days: {}, since: Date.now() }),
    replace() {},
    refresh() {}
};

const state = {
    session: 0, uid: null, user: null, ref: null, ready: false,
    username: "", createdAt: 0, mixes: null, statsSig: "",
    connected: true, syncError: ""
};
const ui = { view: "status", busy: false };
let registering = false;

/* ---------- small helpers ---------- */

const clean = v => JSON.parse(JSON.stringify(v));
const toArray = v => Array.isArray(v) ? v.filter(x => x != null) : (v && typeof v === "object" ? Object.values(v) : []);
const num = v => (typeof v === "number" && isFinite(v)) ? v : 0;
const r1 = v => Math.round(num(v) * 10) / 10;
const newId = () => "pl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const safeId = id => (typeof id === "string" && ID_RE.test(id)) ? id : newId();
const encKey = s => (String(s == null ? "_" : s).slice(0, 200).replace(/[.$#\[\]\/%\u0000-\u001f\u007f]/g,
    c => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))) || "_";
const decKey = s => String(s).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const fail = text => Object.assign(new Error(text), { code: "musify/message" });
const taken = () => Object.assign(new Error("taken"), { code: "musify/username-taken" });
const jsonMap = u => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, JSON.stringify(v)]));

function withTimeout(promise, ms) {
    let timer;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Timed out"), { code: "musify/timeout" })), ms);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function authMessage(e) {
    const code = (e && e.code) || "", msg = (e && e.message) || "";
    if (code === "musify/message") return msg;
    if (code === "musify/username-taken") return "That username is already taken.";
    if (code === "musify/timeout") return "Couldn't reach Firebase. Check your connection and try again.";
    if (/permission[_ -]denied/i.test(code + " " + msg)) {
        return "Firebase rejected the request. Make sure the updated database rules are published.";
    }
    switch (code) {
        case "auth/invalid-email": return "Enter a valid email address.";
        case "auth/user-not-found":
        case "auth/wrong-password":
        case "auth/invalid-credential":
        case "auth/invalid-login-credentials": return "Incorrect email or password.";
        case "auth/email-already-in-use": return "An account with that email already exists. Try logging in.";
        case "auth/weak-password": return "That password is too weak. Use at least 8 characters.";
        case "auth/too-many-requests": return "Too many attempts. Wait a moment and try again.";
        case "auth/network-request-failed": return "Network error. Check your connection and try again.";
        case "auth/user-disabled": return "This account has been disabled.";
        case "auth/operation-not-allowed": return "Email/password sign-in isn't enabled in Firebase.";
    }
    return "Something went wrong. Please try again.";
}

/* ---------- data cleaning (cloud and local data) ---------- */

function cleanTrack(t) {
    if (!t || typeof t !== "object" || t.trackId == null) return null;
    return { ...clean(t), trackId: String(t.trackId) };
}
const cleanTracks = a => toArray(a).map(cleanTrack).filter(Boolean);

function cleanPlaylist(p) {
    if (!p || typeof p !== "object" || typeof p.name !== "string") return null;
    return {
        ...clean(p),
        id: safeId(p.id),
        name: p.name,
        cover: typeof p.cover === "string" ? p.cover : "",
        description: typeof p.description === "string" ? p.description : "",
        tracks: cleanTracks(p.tracks)
    };
}

function normStats(raw, decode) {
    raw = raw && typeof raw === "object" ? raw : {};
    const out = { secs: num(raw.secs), plays: num(raw.plays), since: num(raw.since) || Date.now(), tracks: {}, artists: {}, days: {} };
    const entries = o => Object.entries(o && typeof o === "object" ? o : {});
    entries(raw.tracks).forEach(([id, t]) => {
        if (t && typeof t === "object") out.tracks[id] = { ...t, trackId: String(t.trackId != null ? t.trackId : id), secs: num(t.secs), plays: num(t.plays) };
    });
    entries(raw.artists).forEach(([k, a]) => {
        if (a && typeof a === "object") out.artists[decode ? decKey(k) : k] = { secs: num(a.secs), plays: num(a.plays) };
    });
    entries(raw.days).forEach(([k, v]) => { out.days[k] = num(v); });
    return out;
}
const hasStats = s => s.secs > 0 || s.plays > 0 || Object.keys(s.tracks).length > 0;

function parseMixes(m) {
    if (!m || typeof m !== "object" || typeof m.day !== "string") return null;
    return { day: m.day, mixes: toArray(m.mixes).map(x => ({ ...x, tracks: cleanTracks(x && x.tracks) })) };
}

/* Turns the raw database value of users/<uid> into the structures app.js uses. */
function parseCloud(raw) {
    const profile = raw.profile || {}, lib = raw.library || {};
    const covers = lib.covers && typeof lib.covers === "object" ? lib.covers : {};
    const map = new Map();
    Object.entries(lib.playlists && typeof lib.playlists === "object" ? lib.playlists : {}).forEach(([id, p]) => {
        const c = cleanPlaylist({ ...p, id });
        if (c) { c.cover = typeof covers[id] === "string" ? covers[id] : ""; map.set(id, c); }
    });
    const playlists = [];
    toArray(lib.playlistOrder).forEach(id => { if (map.has(id)) { playlists.push(map.get(id)); map.delete(id); } });
    map.forEach(p => playlists.push(p));
    return {
        liked: cleanTracks(lib.likedTracks),
        playlists,
        name: (typeof profile.displayName === "string" && profile.displayName) ? profile.displayName : (profile.username || ""),
        stats: normStats(raw.stats, true),
        mixes: parseMixes(raw.mixes)
    };
}

/* ---------- cloud "units": each unit is one database path that is saved on its own ---------- */

function libraryUnits(liked, playlists, name) {
    const u = {};
    if (liked.length) u["library/likedTracks"] = clean(liked);
    const ids = [];
    playlists.forEach(p => {
        if (!ID_RE.test(p.id)) return;
        ids.push(p.id);
        const { cover, ...rest } = p;
        u["library/playlists/" + p.id] = clean(rest);
        if (cover) u["library/covers/" + p.id] = cover;
    });
    if (ids.length) u["library/playlistOrder"] = ids;
    if (name) u["profile/displayName"] = name;
    return u;
}

function statsUnits(S) {
    const u = { "stats/secs": r1(S.secs), "stats/plays": Math.round(num(S.plays)), "stats/since": num(S.since) || Date.now() };
    Object.entries(S.tracks || {}).forEach(([id, t]) => {
        if (ID_RE.test(id) && t) u["stats/tracks/" + id] = { ...clean(t), secs: r1(t.secs), plays: Math.round(num(t.plays)) };
    });
    Object.entries(S.artists || {}).forEach(([name, a]) => {
        if (a) u["stats/artists/" + encKey(name)] = { secs: r1(a.secs), plays: Math.round(num(a.plays)) };
    });
    Object.entries(S.days || {}).forEach(([day, v]) => {
        if (DAY_RE.test(day)) u["stats/days/" + day] = r1(v);
    });
    return u;
}

const mixesUnits = m => m ? { mixes: clean(m) } : {};

/* ---------- write channels: debounced, diffed, retried ---------- */

const ch = {
    lib:   { name: "library", delay: 600,   B: {}, pend: new Set(), timer: null, running: null, fails: 0, warned: false,
             build: () => libraryUnits(likedTracks, playlists, displayName) },
    stats: { name: "stats",   delay: 20000, B: {}, pend: new Set(), timer: null, running: null, fails: 0, warned: false,
             build: () => statsUnits(bridge.get()) },
    mixes: { name: "mixes",   delay: 1500,  B: {}, pend: new Set(), timer: null, running: null, fails: 0, warned: false,
             build: () => mixesUnits(state.mixes) }
};

const active = () => Boolean(state.ready && state.uid && auth.currentUser && auth.currentUser.uid === state.uid);
const pendingWork = () => Object.values(ch).some(c => c.timer || c.running);

function schedule(c) {
    if (!active()) return;
    if (!c.timer) c.timer = setTimeout(() => flush(c), c.delay);
    refreshSync();
}

async function flush(c) {
    clearTimeout(c.timer);
    c.timer = null;
    while (c.running) await c.running;
    if (!active()) return;

    const sess = state.session, ref = state.ref;
    const U = c.build();
    const upd = {}, sets = [];

    for (const p in U) {
        const j = JSON.stringify(U[p]);
        if (c.B[p] !== j) { upd[p] = U[p]; sets.push([p, j]); }
    }
    const dels = new Set(c.pend);
    for (const p in c.B) if (!(p in U)) dels.add(p);
    dels.forEach(p => {
        if (p in U) { c.pend.delete(p); }
        else { upd[p] = null; c.pend.add(p); delete c.B[p]; }
    });

    if (!Object.keys(upd).length) { refreshSync(); return; }
    sets.forEach(([p, j]) => { c.B[p] = j; });

    const task = (async () => {
        try {
            await ref.update(upd);
            if (state.session !== sess) return;
            for (const p in upd) if (upd[p] === null) c.pend.delete(p);
            c.fails = 0; c.warned = false; state.syncError = "";
        } catch (e) {
            if (state.session !== sess) return;
            sets.forEach(([p]) => { delete c.B[p]; });   /* forces these to be sent again */
            c.fails++;
            console.warn("Musify sync (" + c.name + ") failed:", e);
            const denied = /permission[_ -]denied/i.test(((e && e.code) || "") + " " + ((e && e.message) || ""));
            if (denied || c.fails >= 6) {
                state.syncError = denied ? "rules" : "failed";
                if (!c.warned) { c.warned = true; showToast(denied ? "Couldn't save: check the database rules" : "Couldn't save to your account"); }
            } else {
                if (!c.warned) { c.warned = true; showToast("Couldn't save. Retrying…"); }
                c.timer = setTimeout(() => flush(c), Math.min(30000, 1500 * Math.pow(2, c.fails)));
            }
        } finally {
            c.running = null;
            refreshSync();
        }
    })();
    c.running = task;
    refreshSync();
    await task;
}

const flushAll = () => Promise.all(Object.values(ch).map(flush));

function stopWrites() {
    state.ready = false;
    Object.values(ch).forEach(c => { clearTimeout(c.timer); c.timer = null; });
}

function rebaseline() {
    ch.lib.B = jsonMap(libraryUnits(likedTracks, playlists, displayName));
    ch.stats.B = jsonMap(statsUnits(bridge.get()));
    ch.mixes.B = jsonMap(mixesUnits(state.mixes));
    const S = bridge.get();
    state.statsSig = S.secs + "|" + S.plays;
    Object.values(ch).forEach(c => { c.pend.clear(); c.fails = 0; c.warned = false; });
    state.syncError = "";
}

/* ---------- wrap app.js storage functions ---------- */

const _safeSet = safeSet, _safeGet = safeGet;

safeSet = function (key, value) {
    if (!CLOUD_KEYS.has(key)) return _safeSet(key, value);
    if (!state.ready) return true;                 /* nobody is signed in / data not loaded yet */
    if (key === "musify-mixes") { state.mixes = value; schedule(ch.mixes); }
    else if (key === "musify-stats") {
        const S = bridge.get(), sig = S.secs + "|" + S.plays;
        if (sig !== state.statsSig) { state.statsSig = sig; schedule(ch.stats); }
    }
    else schedule(ch.lib);
    return true;
};

safeGet = function (key, fallback) {
    if (key === "musify-mixes") return (state.ready && state.mixes) ? state.mixes : fallback;
    if (CLOUD_KEYS.has(key)) return fallback;      /* never read private data from shared local storage */
    return _safeGet(key, fallback);
};

/* The library now lives in the account, so the cookie texts are updated to match. */
updateCookieStatus = function () {
    const node = $("cookieStatus");
    if (!node) return;
    node.textContent = consent === "accepted"
        ? "Playback sources are remembered on this device. Your library is saved to your account."
        : consent === "declined"
            ? "Nothing extra is saved on this device. Your library is still saved to your account."
            : "No choice made yet.";
};
{
    const bannerText = document.querySelector("#cookieBanner p");
    if (bannerText) bannerText.textContent = "Cookies and browser storage remember your choices and speed up playback on this device. Your library is saved to your account.";
    const _openPanel = openPanel;
    openPanel = function (type) {
        _openPanel(type);
        if (type === "cookies") {
            const p = panelBody.querySelectorAll(".dialog-sub");
            if (p[0]) p[0].textContent = "Musify uses a cookie to remember this choice, and local storage to remember which audio sources work best on this device. Your playlists, liked songs and stats are saved to your account.";
            if (p[1]) p[1].textContent = "If you decline, those device-only caches are deleted. Your account data is not affected.";
        }
    };
}

/* ---------- sync status text ---------- */

function refreshSync() {
    const node = $("acctSync");
    if (!node) return;
    node.textContent = state.syncError ? "Couldn't save your latest changes."
        : !state.connected ? "Offline. Changes will sync when you reconnect."
        : pendingWork() ? "Saving…"
        : "All changes saved to your account.";
}

/* ---------- the account modal ---------- */

let overlay = $("authOverlay"), panel = $("authPanel");
if (!overlay) {
    overlay = el("div", "auth-overlay open");
    overlay.id = "authOverlay";
    panel = el("div", "auth-panel");
    panel.id = "authPanel";
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
}
overlay.setAttribute("role", "dialog");
overlay.setAttribute("aria-modal", "true");
overlay.setAttribute("aria-label", "Musify account");

function lockPage(lock) {
    [...document.body.children].forEach(node => {
        if (node !== overlay && node.tagName !== "SCRIPT") node.inert = lock;
    });
    overlay.classList.toggle("open", lock);
}

function resetPanel() {
    lockPage(true);
    panel.innerHTML = "";
    const brand = el("div", "auth-brand");
    brand.innerHTML = "MUSIFY<span>.</span>";
    panel.appendChild(brand);
}

const hideAuth = () => lockPage(false);

function focusLater(input) {
    if (input && !matchMedia("(hover: none)").matches) setTimeout(() => input.focus(), 60);
}

function showStatus(text) {
    ui.view = "status";
    resetPanel();
    const row = el("div", "auth-status");
    row.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    row.appendChild(el("span", "", text));
    panel.appendChild(row);
}

function showFatal(text) {
    ui.view = "fatal";
    resetPanel();
    panel.appendChild(el("div", "auth-error", text));
    const retry = el("button", "btn primary auth-submit", "Reload");
    retry.onclick = () => location.reload();
    panel.appendChild(retry);
}

function addField(form, label, type, name, autocomplete, withToggle) {
    const wrap = el("div", "auth-field");
    const lab = el("label", "", label);
    lab.htmlFor = "auth-" + name;
    const input = el("input", "text-input");
    input.id = "auth-" + name;
    input.name = name;
    input.type = type;
    input.autocomplete = autocomplete;
    input.spellcheck = false;
    input.autocapitalize = "none";
    wrap.appendChild(lab);

    if (withToggle) {
        const box = el("div", "auth-pass");
        box.appendChild(input);
        const eye = el("button", "auth-eye");
        eye.type = "button";
        eye.title = "Show password";
        eye.setAttribute("aria-label", "Show password");
        eye.innerHTML = '<i class="fa-regular fa-eye"></i>';
        eye.onclick = () => {
            const show = input.type === "password";
            input.type = show ? "text" : "password";
            eye.innerHTML = '<i class="fa-regular fa-eye' + (show ? "-slash" : "") + '"></i>';
            eye.title = show ? "Hide password" : "Show password";
            eye.setAttribute("aria-label", eye.title);
        };
        box.appendChild(eye);
        wrap.appendChild(box);
    } else {
        wrap.appendChild(input);
    }
    form.appendChild(wrap);
    return input;
}

/* shared form: handles the loading state, the inline error box and duplicate submits */
function makeForm(submitLabel, busyLabel, onSubmit) {
    const form = el("form");
    form.noValidate = true;
    const kit = { form, inputs: [], extra: [], busy: false };
    const err = el("div", "auth-error");
    err.hidden = true;
    err.setAttribute("role", "alert");
    const submit = el("button", "btn primary auth-submit", submitLabel);
    submit.type = "submit";

    kit.field = (label, type, name, autocomplete, toggle) => {
        const input = addField(form, label, type, name, autocomplete, toggle);
        kit.inputs.push(input);
        return input;
    };
    kit.finish = () => { form.appendChild(err); form.appendChild(submit); };
    kit.error = msg => { err.textContent = msg || ""; err.hidden = !msg; };
    kit.setBusy = busy => {
        kit.busy = busy;
        ui.busy = busy;
        kit.inputs.forEach(i => { i.disabled = busy; });
        kit.extra.forEach(b => { b.disabled = busy; });
        submit.disabled = busy;
        submit.innerHTML = "";
        if (busy) submit.appendChild(el("i", "fa-solid fa-spinner fa-spin"));
        submit.appendChild(document.createTextNode(busy ? busyLabel : submitLabel));
    };
    form.addEventListener("submit", event => {
        event.preventDefault();
        if (kit.busy) return;
        onSubmit(kit);
    });
    return kit;
}

function showForm(mode) {
    ui.view = mode;
    ui.busy = false;
    resetPanel();
    panel.appendChild(el("p", "auth-sub", mode === "login" ? "Log in to open your library." : "Create an account to save your music."));

    const tabs = el("div", "auth-tabs");
    const tabButtons = [];
    [["login", "Log in"], ["register", "Create account"]].forEach(([m, label]) => {
        const b = el("button", "auth-tab" + (m === mode ? " active" : ""), label);
        b.type = "button";
        b.onclick = () => { if (!ui.busy && m !== mode) showForm(m); };
        tabs.appendChild(b);
        tabButtons.push(b);
    });
    panel.appendChild(tabs);

    const kit = makeForm(
        mode === "login" ? "Log in" : "Create account",
        mode === "login" ? "Logging in…" : "Creating account…",
        mode === "login" ? doLogin : doRegister
    );
    kit.extra = tabButtons;

    kit.username = mode === "register" ? kit.field("Username", "text", "username", "username") : null;
    kit.email = kit.field("Email", "email", "email", "email");
    kit.password = kit.field("Password", "password", "password", mode === "login" ? "current-password" : "new-password", true);
    kit.confirm = mode === "register" ? kit.field("Confirm password", "password", "confirm", "new-password", true) : null;

    if (mode === "register") {
        kit.password.closest(".auth-field").appendChild(el("div", "auth-hint", "At least 8 characters."));
        kit.username.closest(".auth-field").appendChild(el("div", "auth-hint", "3–20 characters: letters, numbers, underscores."));
    }
    kit.finish();
    panel.appendChild(kit.form);
    focusLater(kit.username || kit.email);
}

async function doLogin(kit) {
    const email = kit.email.value.trim(), pass = kit.password.value;
    if (!EMAIL_RE.test(email)) return kit.error("Enter a valid email address.");
    if (!pass) return kit.error("Enter your password.");
    kit.error("");
    kit.setBusy(true);
    try {
        await auth.signInWithEmailAndPassword(email, pass);
        /* onAuthStateChanged takes over from here and loads the library */
    } catch (e) {
        kit.setBusy(false);
        kit.error(authMessage(e));
    }
}

/* ---------- usernames ---------- */

async function usernameFree(lower) {
    try {
        const snap = await db.ref("usernames/" + lower).once("value");
        return !snap.exists();
    } catch { return true; }   /* can't pre-check; the real claim below is what counts */
}

async function claimUsername(lower, uid) {
    const result = await db.ref("usernames/" + lower).transaction(current =>
        current === null ? uid : (current === uid ? current : undefined));
    if (!result.committed || result.snapshot.val() !== uid) throw taken();
}

async function rollbackRegistration(user, lower) {
    if (!user) return;
    try {
        const snap = await db.ref("usernames/" + lower).once("value");
        if (snap.val() === user.uid) await db.ref("usernames/" + lower).remove();
    } catch {}
    try { await user.delete(); }
    catch { try { await auth.signOut(); } catch {} }
}

async function doRegister(kit) {
    const username = kit.username.value.trim(), email = kit.email.value.trim();
    const pass = kit.password.value, confirmPass = kit.confirm.value;

    if (!USERNAME_RE.test(username)) return kit.error("Username must be 3–20 characters: letters, numbers or underscores.");
    if (!EMAIL_RE.test(email)) return kit.error("Enter a valid email address.");
    if (pass.length < 8) return kit.error("Password must be at least 8 characters.");
    if (pass !== confirmPass) return kit.error("Passwords don't match.");

    kit.error("");
    kit.setBusy(true);
    registering = true;
    const lower = username.toLowerCase();
    let created = null;

    try {
        if (!(await usernameFree(lower))) throw taken();
        created = (await auth.createUserWithEmailAndPassword(email, pass)).user;
        await claimUsername(lower, created.uid);
        await db.ref("users/" + created.uid + "/profile").set({
            username,
            displayName: username,
            createdAt: firebase.database.ServerValue.TIMESTAMP
        });
    } catch (e) {
        await rollbackRegistration(created, lower);
        registering = false;
        kit.setBusy(false);
        kit.error(authMessage(e));
        return;
    }

    registering = false;
    startSession(created);
}

/* shown if an account exists but never got a username (e.g. an interrupted sign-up) */
function promptUsername(user, existing) {
    return new Promise(resolve => {
        ui.view = "username";
        resetPanel();
        panel.appendChild(el("p", "auth-sub", "Choose a username to finish setting up your account."));

        const kit = makeForm("Continue", "Saving…", async k => {
            const name = input.value.trim();
            if (!USERNAME_RE.test(name)) return k.error("Username must be 3–20 characters: letters, numbers or underscores.");
            k.error("");
            k.setBusy(true);
            try {
                await claimUsername(name.toLowerCase(), user.uid);
                await db.ref("users/" + user.uid + "/profile").update({
                    username: name,
                    displayName: existing.displayName || name,
                    createdAt: existing.createdAt || firebase.database.ServerValue.TIMESTAMP
                });
                resolve(name);
            } catch (e) {
                k.setBusy(false);
                k.error(authMessage(e));
            }
        });
        const input = kit.field("Username", "text", "username", "username");
        kit.finish();
        const out = el("button", "btn auth-submit", "Log out");
        out.type = "button";
        out.onclick = () => auth.signOut().catch(() => {});
        kit.extra = [out];
        kit.form.appendChild(out);
        panel.appendChild(kit.form);
        focusLater(input);
    });
}

/* ---------- migrating old local data ---------- */

function readLocal() {
    const get = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
    const seen = new Set();
    const playlistsLocal = toArray(get("musify-playlists")).map(cleanPlaylist).filter(p => {
        if (!p || seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
    });
    const liked = cleanTracks(get("musify-liked"));
    const nm = get("musify-name");
    const name = (typeof nm === "string" && nm.trim() && nm !== DEFAULT_NAME) ? nm.trim() : "";
    const stats = normStats(get("musify-stats"), false);
    return { liked, playlists: playlistsLocal, name, stats, has: Boolean(liked.length || playlistsLocal.length || name || hasStats(stats)) };
}

function describeLocal(l) {
    const parts = [];
    if (l.liked.length) parts.push(l.liked.length + " liked song" + (l.liked.length === 1 ? "" : "s"));
    if (l.playlists.length) parts.push(l.playlists.length + " playlist" + (l.playlists.length === 1 ? "" : "s"));
    if (hasStats(l.stats)) parts.push("listening stats");
    if (l.name) parts.push("your display name");
    return parts;
}

function mergeStats(a, b) {
    const out = clean(a);
    out.secs += b.secs;
    out.plays += b.plays;
    out.since = Math.min(...[a.since, b.since].filter(Boolean));
    Object.entries(b.tracks).forEach(([id, t]) => {
        const e = out.tracks[id];
        if (e) { e.secs += t.secs; e.plays += t.plays; } else out.tracks[id] = clean(t);
    });
    Object.entries(b.artists).forEach(([k, t]) => {
        const e = out.artists[k];
        if (e) { e.secs += t.secs; e.plays += t.plays; } else out.artists[k] = clean(t);
    });
    Object.entries(b.days).forEach(([k, v]) => { out.days[k] = (out.days[k] || 0) + v; });
    return out;
}

/* adds local data to cloud data without duplicating anything */
function mergeData(base, local) {
    const liked = base.liked.slice();
    const have = new Set(liked.map(t => t.trackId));
    local.liked.forEach(t => { if (!have.has(t.trackId)) { have.add(t.trackId); liked.push(t); } });

    const pls = base.playlists.map(p => ({ ...p, tracks: p.tracks.slice() }));
    const byId = new Map(pls.map(p => [p.id, p]));
    const signature = p => p.tracks.map(t => t.trackId).sort().join(",");

    local.playlists.forEach(lp => {
        const existing = byId.get(lp.id);
        if (existing) {
            const ids = new Set(existing.tracks.map(t => t.trackId));
            lp.tracks.forEach(t => { if (!ids.has(t.trackId)) { ids.add(t.trackId); existing.tracks.push(t); } });
            if (!existing.cover && lp.cover) existing.cover = lp.cover;
            if (!existing.description && lp.description) existing.description = lp.description;
            return;
        }
        const duplicate = pls.find(p => p.name.trim().toLowerCase() === lp.name.trim().toLowerCase() && signature(p) === signature(lp));
        if (duplicate) return;
        pls.push(lp);
        byId.set(lp.id, lp);
    });

    const useLocalName = local.name && (!base.name || base.name === state.username);
    return {
        liked,
        playlists: pls,
        name: useLocalName ? local.name : base.name,
        stats: hasStats(local.stats) ? mergeStats(base.stats, local.stats) : base.stats,
        mixes: base.mixes
    };
}

/* writes the merged data to the cloud; local data is deleted ONLY after that succeeds */
async function importLocal(base, local) {
    const merged = mergeData(base, local);
    const updates = Object.assign({}, libraryUnits(merged.liked, merged.playlists, merged.name), statsUnits(merged.stats));
    updates["meta/migration"] = { status: "imported", at: firebase.database.ServerValue.TIMESTAMP };
    await state.ref.update(updates);
    try { LOCAL_KEYS.forEach(k => localStorage.removeItem(k)); } catch {}
    return merged;
}

const skipKey = uid => "musify-import-skipped-" + uid;
const wasSkipped = uid => { try { return localStorage.getItem(skipKey(uid)) === "1"; } catch { return false; } };
const markSkipped = uid => { try { localStorage.setItem(skipKey(uid), "1"); } catch {} };

function promptImport(local) {
    return new Promise(resolve => {
        ui.view = "import";
        resetPanel();
        panel.appendChild(el("p", "auth-sub", "We found music saved on this device before accounts existed:"));
        const list = el("ul", "auth-list");
        describeLocal(local).forEach(text => list.appendChild(el("li", "", text)));
        panel.appendChild(list);

        const yes = el("button", "btn primary auth-submit", "Import to this account");
        const no = el("button", "btn auth-submit", "Not now");
        yes.onclick = () => resolve("import");
        no.onclick = () => resolve("skip");
        panel.appendChild(yes);
        panel.appendChild(no);
        panel.appendChild(el("div", "auth-hint", "“Not now” keeps it on this device. You can import it later from Settings."));
    });
}

/* ---------- sessions ---------- */

const stale = (sess, user) => sess !== state.session || state.uid !== user.uid;

function applyMemory(d) {
    likedTracks = d.liked;
    playlists = d.playlists;
    displayName = d.name;
    bridge.replace(d.stats);
    if (d.mixes !== undefined) state.mixes = d.mixes;
    rebaseline();
}

async function startSession(user) {
    const sess = ++state.session;
    state.uid = user.uid;
    state.user = user;
    state.ref = db.ref("users/" + user.uid);
    state.ready = false;
    showStatus("Loading your library…");

    try {
        const snap = await withTimeout(state.ref.once("value"), 20000);
        if (stale(sess, user)) return;
        const raw = snap.val() || {};
        let profile = raw.profile || {};

        if (!profile.username) {
            const name = await promptUsername(user, profile);
            if (stale(sess, user)) return;
            profile = { ...profile, username: name, displayName: profile.displayName || name };
            raw.profile = profile;
            showStatus("Loading your library…");
        }
        state.username = profile.username;

        let data = parseCloud(raw);
        const imported = raw.meta && raw.meta.migration && raw.meta.migration.status === "imported";
        const local = readLocal();

        if (!imported && local.has && !wasSkipped(user.uid)) {
            const choice = await promptImport(local);
            if (stale(sess, user)) return;
            if (choice === "import") {
                showStatus("Importing your music…");
                data = await importLocal(data, local);
                if (stale(sess, user)) return;
            } else {
                markSkipped(user.uid);
            }
        }

        finishSession(user, raw, profile, data);
    } catch (e) {
        if (stale(sess, user)) return;
        console.error("Musify: couldn't load account data", e);
        showLoadError(e, user);
    }
}

function finishSession(user, raw, profile, data) {
    state.createdAt = Date.parse(user.metadata && user.metadata.creationTime) || (typeof profile.createdAt === "number" ? profile.createdAt : 0);
    applyMemory(data);

    const fix = {};
    if (!(profile.displayName) && displayName) fix["profile/displayName"] = displayName;
    if (!(raw.stats && raw.stats.since)) fix["stats/since"] = bridge.get().since;
    if (Object.keys(fix).length) state.ref.update(fix).catch(() => {});

    state.ready = true;
    refreshAccountUI();
    updateNameStatus();
    refreshLibraryViews();
    bridge.refresh();
    updateCookieStatus();
    loadTrending();
    hideAuth();
}

function showLoadError(e, user) {
    ui.view = "error";
    resetPanel();
    panel.appendChild(el("p", "auth-sub", "We couldn't load your library."));
    panel.appendChild(el("div", "auth-error", authMessage(e)));
    const retry = el("button", "btn primary auth-submit", "Try again");
    const out = el("button", "btn auth-submit", "Log out");
    retry.onclick = () => startSession(user);
    out.onclick = () => auth.signOut().catch(() => {});
    panel.appendChild(retry);
    panel.appendChild(out);
}

/* ---------- account section in Settings ---------- */

function buildAccountSettings() {
    const section = document.querySelector("#settings .section");
    if (!section) return;
    const wrap = el("div");
    wrap.id = "acctSettings";
    wrap.innerHTML = `
        <div class="acct-label">ACCOUNT</div>
        <div class="setting-row"><div><h3>Username</h3><p id="acctUsername"></p></div><button id="acctChangeUser">Change</button></div>
        <div class="setting-row"><div><h3>Email</h3><p id="acctEmail"></p></div></div>
        <div class="setting-row"><div><h3>Account created</h3><p id="acctCreated"></p></div></div>
        <div class="setting-row"><div><h3>Cloud sync</h3><p id="acctSync"></p></div></div>
        <div class="setting-row" id="acctImportRow" hidden><div><h3>Saved on this device</h3><p>Playlists and stats from before accounts existed.</p></div><button id="acctImport">Import</button></div>
        <div class="setting-row"><div><h3>Log out</h3><p>Sign out of Musify on this device.</p></div><button id="acctLogout">Log out</button></div>`;
    section.insertBefore(wrap, section.firstChild);
    $("acctChangeUser").onclick = changeUsernameDialog;
    $("acctImport").onclick = importFromDevice;
    $("acctLogout").onclick = logout;
}

function refreshAccountUI() {
    if (!$("acctUsername")) return;
    $("acctUsername").textContent = state.username || "—";
    $("acctEmail").textContent = (state.user && state.user.email) || "—";
    $("acctCreated").textContent = state.createdAt ? formatDate(state.createdAt) : "—";
    $("acctImportRow").hidden = !(state.ready && readLocal().has);
    refreshSync();
}

async function changeUsername(newName) {
    if (!USERNAME_RE.test(newName)) throw fail("Username must be 3–20 characters: letters, numbers or underscores.");
    if (newName === state.username) return;
    const uid = state.uid;
    const oldLower = state.username.toLowerCase(), newLower = newName.toLowerCase();
    const moving = newLower !== oldLower;

    if (moving) await claimUsername(newLower, uid);
    try {
        await state.ref.child("profile/username").set(newName);
    } catch (e) {
        if (moving) { try { await db.ref("usernames/" + newLower).remove(); } catch {} }
        throw e;
    }
    if (moving) {
        try { await db.ref("usernames/" + oldLower).remove(); }
        catch (e) { console.warn("Musify: couldn't release the old username", e); }
    }
    state.username = newName;
    refreshAccountUI();
}

function changeUsernameDialog() {
    if (!state.ready) return;
    const body = openDialog("Change username");
    body.appendChild(el("p", "dialog-sub", "3–20 characters: letters, numbers and underscores. Usernames are unique."));
    const err = el("div", "auth-error");
    err.hidden = true;
    body.appendChild(err);

    const input = el("input", "text-input");
    input.type = "text";
    input.maxLength = 20;
    input.value = state.username;
    input.autocomplete = "off";
    input.spellcheck = false;
    body.appendChild(input);

    const actions = el("div", "panel-actions");
    const save = el("button", "btn primary", "Save");
    const cancel = el("button", "btn", "Cancel");
    let busy = false;

    const submit = async () => {
        if (busy) return;
        busy = true;
        save.disabled = true;
        err.hidden = true;
        try {
            await changeUsername(input.value.trim());
            closeDialog();
            showToast("Username updated");
        } catch (e) {
            busy = false;
            save.disabled = false;
            err.textContent = authMessage(e);
            err.hidden = false;
        }
    };
    save.onclick = submit;
    cancel.onclick = () => closeDialog();
    input.addEventListener("keydown", event => { if (event.key === "Enter") submit(); });
    actions.appendChild(save);
    actions.appendChild(cancel);
    body.appendChild(actions);
    setTimeout(() => { input.focus(); input.select(); }, 60);
}

function importFromDevice() {
    if (!state.ready) return;
    const local = readLocal();
    if (!local.has) { refreshAccountUI(); return; }

    const body = openDialog("Import saved data");
    body.appendChild(el("p", "dialog-sub", "Add what's saved on this device (" + describeLocal(local).join(", ") + ") to your account? Nothing will be duplicated."));
    const err = el("div", "auth-error");
    err.hidden = true;
    body.appendChild(err);

    const actions = el("div", "panel-actions");
    const go = el("button", "btn primary", "Import");
    const cancel = el("button", "btn", "Cancel");
    let busy = false;

    go.onclick = async () => {
        if (busy) return;
        busy = true;
        go.disabled = true;
        try {
            await flushAll();
            const base = { liked: likedTracks, playlists, name: displayName, stats: bridge.get(), mixes: state.mixes };
            const merged = await importLocal(base, local);
            applyMemory(merged);
            updateNameStatus();
            refreshLibraryViews();
            bridge.refresh();
            refreshAccountUI();
            closeDialog();
            showToast("Imported to your account");
        } catch (e) {
            console.error(e);
            busy = false;
            go.disabled = false;
            err.textContent = authMessage(e);
            err.hidden = false;
        }
    };
    cancel.onclick = () => closeDialog();
    actions.appendChild(go);
    actions.appendChild(cancel);
    body.appendChild(actions);
}

async function logout() {
    const button = $("acctLogout");
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "Logging out…";
    try { await Promise.race([flushAll(), new Promise(resolve => setTimeout(resolve, 5000))]); } catch {}
    stopWrites();   /* nothing from this account is written after this point */
    try {
        await auth.signOut();
    } catch (e) {
        state.ready = true;
        button.disabled = false;
        button.textContent = "Log out";
        showToast("Couldn't log out. Please try again.");
        return;
    }
    setTimeout(() => location.reload(), 700);   /* normally the auth listener reloads first */
}

/* ---------- auth state ---------- */

function onAuth(user) {
    if (registering) return;   /* sign-up is still claiming the username; it starts the session itself */

    if (!user) {
        if (state.uid) {       /* logged out (here or in another tab): wipe everything by reloading */
            stopWrites();
            location.reload();
            return;
        }
        if (ui.view !== "login" && ui.view !== "register") showForm("login");
        return;
    }

    if (state.uid && state.uid !== user.uid) {   /* a different account signed in elsewhere */
        stopWrites();
        location.reload();
        return;
    }
    if (state.uid === user.uid) return;          /* session already running */
    startSession(user);
}

/* ---------- start ---------- */

/* Nothing saved on this device may show up before (or after) someone else logs in. */
likedTracks = [];
playlists = [];
displayName = "";
bridge.replace(null);
refreshLibraryViews();
updateNameStatus();
updateCookieStatus();
buildAccountSettings();
lockPage(true);

addEventListener("pagehide", () => { if (state.ready) flushAll(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && state.ready) flushAll(); });
addEventListener("beforeunload", event => {
    if (state.ready && (state.syncError || (!state.connected && pendingWork()))) {
        event.preventDefault();
        event.returnValue = "";
    }
});

if (!auth || !db) {
    showFatal("Couldn't connect to Firebase. Check your connection and reload.");
} else {
    showStatus("Checking your session…");
    db.ref(".info/connected").on("value", snap => { state.connected = Boolean(snap.val()); refreshSync(); });
    auth.onAuthStateChanged(onAuth, error => {
        console.error("Musify auth error", error);
        showFatal(authMessage(error));
    });
}
})();
