/**
 * @file Current game state with subscribe/notify, and where it is saved.
 *
 * The state is { tasks, ledger, campaign }. With the real data it is saved
 * on the server (one document per user, see server/routes/campaign.js):
 * loaded when the app starts, saved shortly after every change, retried
 * when the network fails. The server settles the days (syncDay()), in the
 * time zone sent with each save. Test sessions (see session.js) stay in
 * this browser's localStorage and settle in the browser; the "demo" one is
 * filled with generated data the first time (or again after a reset).
 */

import { generateDemoData } from '/engine/demo.js';
import { session, prefix } from './session.js';
import { now } from './clock.js';
import { loadSave, putSave, settleSave } from './api.js';

export { session };

/**
 * @template T
 * @param {T} initial
 */
export function createStore(initial) {
    let state = initial;
    const listeners = new Set();
    return {
        /** @returns {T} */
        get: () => state,
        /** Replace the state with fn(state) and notify subscribers. */
        update(fn) {
            state = fn(state);
            for (const l of listeners) l(state);
        },
        /** Call fn on every change; returns an unsubscribe function. */
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}

/* ---------- Shape of the saved state ---------- */

/** A complete, well-formed state from whatever was saved (old versions included). */
function normalize(data) {
    const tasks = Array.isArray(data?.tasks) ? data.tasks.map(({ priority: _priority, ...task }) => task) : [];
    const ledger = data?.ledger && typeof data.ledger.balance === 'number' ? data.ledger : { balance: 0, settledThrough: null };
    // Units of the current map, or null: app.js deploys new ones when needed
    const campaign = data?.campaign && Array.isArray(data.campaign.units) && typeof data.campaign.seed === 'string' ? data.campaign : null;
    return { tasks, ledger, campaign };
}

/* ---------- localStorage (test sessions, and data from before the server) ---------- */

const KEYS = { tasks: `${prefix}tasks.v1`, ledger: `${prefix}ledger.v1`, campaign: `${prefix}campaign.v1` };

function readLocal() {
    const read = (key) => {
        try {
            return JSON.parse(localStorage.getItem(key));
        } catch {
            return null;
        }
    };
    const raw = { tasks: read(KEYS.tasks), ledger: read(KEYS.ledger), campaign: read(KEYS.campaign) };
    return raw.tasks === null && raw.ledger === null && raw.campaign === null ? null : raw;
}

function writeLocal(state) {
    try {
        for (const [name, key] of Object.entries(KEYS)) localStorage.setItem(key, JSON.stringify(state[name]));
    } catch {
        // Private mode or storage full: keep working in memory
    }
}

function clearLocal() {
    try {
        for (const key of Object.values(KEYS)) localStorage.removeItem(key);
    } catch {
        // Nothing to clear
    }
}

/* ---------- Server ---------- */

/**
 * Save status, for the indicator in the top bar:
 * 'saved' | 'saving' | 'offline' (will retry) | 'conflict' (saved elsewhere: reloading) | 'local' (test session).
 */
const statusListeners = new Set();
let status = session ? 'local' : 'saved';
function setStatus(s) {
    status = s;
    for (const l of statusListeners) l(s);
}
export const saveStatus = {
    get: () => status,
    subscribe(fn) {
        statusListeners.add(fn);
        fn(status);
        return () => statusListeners.delete(fn);
    },
};

/**
 * Saves to the server: debounced, one request at a time, retried with backoff.
 * @param {number} startVersion
 * @param {() => void} [onFirstSave] Called after the first successful save.
 */
function createRemoteSaver(startVersion, onFirstSave) {
    let version = startVersion;
    let pending = null; // latest state not yet sent
    let inFlight = false;
    let timer = null;
    let retryDelay = 2000;

    const schedule = (delay) => {
        clearTimeout(timer);
        timer = setTimeout(flush, delay);
    };

    async function flush() {
        clearTimeout(timer);
        if (inFlight || pending === null) return;
        const data = pending;
        pending = null;
        inFlight = true;
        setStatus('saving');
        try {
            ({ version } = await putSave(data, version));
            retryDelay = 2000;
            onFirstSave?.();
            onFirstSave = null;
            setStatus(pending === null ? 'saved' : 'saving');
        } catch (err) {
            if (err.status === 409) {
                // Saved from another device in between: load that version
                setStatus('conflict');
                setTimeout(() => location.reload(), 1500);
                return;
            }
            if (err.status === 401) {
                location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
                return;
            }
            // Network or server error: keep the data and try again later
            pending ??= data;
            setStatus('offline');
            schedule(retryDelay);
            retryDelay = Math.min(retryDelay * 2, 60_000);
        } finally {
            inFlight = false;
        }
        if (pending !== null && status !== 'offline') schedule(0);
    }

    // Leaving the page: send what is left (keepalive requests are capped at 64 KB)
    const sendNow = () => {
        if (pending === null) return;
        const body = JSON.stringify({ data: pending, version });
        if (body.length < 60_000) {
            fetch('/api/save', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
                credentials: 'same-origin',
            }).catch(() => {});
        }
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
    addEventListener('pagehide', sendNow);
    // Warn before closing with unsaved changes
    addEventListener('beforeunload', (e) => {
        if (pending !== null || inFlight) e.preventDefault();
    });

    /** Send what is pending now; resolves false if the server cannot be reached. */
    async function flushNow() {
        for (let i = 0; i < 100 && (pending !== null || inFlight); i++) {
            if (inFlight) await new Promise((r) => setTimeout(r, 50));
            else await flush();
            if (status === 'offline' || status === 'conflict') return false;
        }
        return pending === null && !inFlight;
    }

    return {
        save(state) {
            // The server settles days at the player's midnight: tell it where that is
            pending = { ...state, timeZone };
            if (status !== 'offline') setStatus('saving');
            schedule(800);
        },
        flushNow,
        get version() {
            return version;
        },
        set version(v) {
            version = v;
        },
    };
}

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/* ---------- Start ---------- */

let initial;
let persist;
let saver = null;
if (session) {
    const local = readLocal();
    initial = session === 'demo' && local === null ? { ...generateDemoData({ now: now() }), campaign: null } : normalize(local);
    persist = writeLocal;
    writeLocal(initial);
} else {
    const remote = await loadSave();
    if (remote.data) {
        initial = normalize(remote.data);
        clearLocal(); // the server's copy wins
        saver = createRemoteSaver(remote.version);
    } else {
        // Nothing on the server yet: upload what this browser kept before,
        // and forget the local copy only once the server has it
        const local = readLocal();
        initial = normalize(local);
        saver = createRemoteSaver(0, clearLocal);
        if (local) saver.save(initial);
    }
    persist = saver.save;
}

export const store = createStore(initial);
// Changes coming from the server are not sent back to it
let applyingRemote = false;
store.subscribe((s) => {
    if (!applyingRemote) persist(s);
});

/** Whether the days are settled by the server (real data) or here (test sessions). */
export const settledByServer = saver !== null;

/**
 * Server only: send pending changes, let the server settle the days that
 * ended, take its version if it changed. Returns the settlement reports the
 * server keeps until they are acknowledged, or null when offline.
 * @returns {Promise<object[]|null>}
 */
export async function syncDay() {
    if (!saver) return [];
    if (!(await saver.flushNow())) return null;
    let remote;
    try {
        remote = await settleSave();
    } catch {
        return null;
    }
    if (remote.version !== saver.version && remote.data) {
        applyingRemote = true;
        try {
            store.update(() => normalize(remote.data));
        } finally {
            applyingRemote = false;
        }
        saver.version = remote.version;
    }
    return remote.news;
}
