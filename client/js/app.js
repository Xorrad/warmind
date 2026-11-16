/**
 * @file The app, loaded by main.js once the user is logged in: map,
 * tasks, units, daily settlement.
 *
 * The game is saved on the server (store.js). Each campaign has its own
 * map seed, saved with it. Test sessions (?session=...) stay in the
 * browser and also accept a ?seed=... and the seed controls of the top
 * bar, which would wipe a real campaign.
 */

import { generateMap } from '/engine/mapgen.js';
import { deployUnits, ownedMap } from '/engine/units.js';
import { settleGame } from '/engine/turn.js';
import { createMapView } from './ui/map.js';
import { createGameController } from './game.js';
import { createBattleDialog } from './ui/battle.js';
import { createDispatchDialog } from './ui/dispatch.js';
import { currentUser } from './user.js';
import { logout, ackNews } from './api.js';
import { renderVersion, renderPoints, setupPointsPopover } from './ui/topbar.js';
import { renderTasks, setupPanelToggles } from './ui/tasks.js';
import { createTaskDialog, createConfirmDialog, closeOnBackdrop } from './ui/modals.js';
import { store, session, saveStatus, settledByServer, syncDay } from './store.js';
import { now as clockNow, canSkip, skipDays, skippedDays } from './clock.js';
import { createTask, updateTask, toggleDone, isDoneToday } from '/engine/tasks.js';
import { estimateToday, completionGains } from '/engine/tick.js';

const seedInput = /** @type {HTMLInputElement} */ (document.getElementById('seed'));
const modeButton = document.getElementById('mode');
/** The generated map, and the same map with the campaign's current owners. */
let baseMap = null;
let map = null;
let mapCampaign = null;
let mode = 'political';

/** Recompute the displayed map when the campaign (owners) changed. */
function syncMap() {
    const { campaign } = store.get();
    if (!baseMap || campaign === mapCampaign) return false;
    const before = map;
    map = ownedMap(baseMap, campaign);
    mapCampaign = campaign;
    return before !== null && before.provinces.some((p, i) => p.owner !== map.provinces[i].owner);
}

const view = createMapView(document.getElementById('map'), {
    onSelect: (province) => game.selectProvince(province),
    onUnitClick: (unitId, event) => game.selectUnit(unitId, event),
});
const game = createGameController({
    view,
    store,
    getMap: () => map,
    info: document.getElementById('province-info'),
    actionBar: document.getElementById('action-bar'),
    toast: document.getElementById('toast'),
    battle: createBattleDialog(document.getElementById('battle-dialog')),
});

function load(seed) {
    seedInput.value = seed;
    if (session) {
        // Test sessions: keep the seed in the URL so a map can be shared
        const url = new URL(location.href);
        url.searchParams.set('seed', seed);
        history.replaceState(null, '', url);
    }

    baseMap = generateMap({ seed });
    map = null;
    mapCampaign = null;
    game.reset();
    // Units and owners belong to a map: start a new campaign for a new seed
    if (store.get().campaign?.seed !== baseMap.seed) store.update((s) => ({ ...s, campaign: deployUnits(baseMap) }));
    syncMap();
    view.render(map);
    settle();
    renderAll();
    game.refresh();
}

/* ---------- Tasks ---------- */

const panels = {
    todo: document.getElementById('todo-list'),
    streaks: document.getElementById('streak-list'),
    completed: document.getElementById('completed-list'),
};
const pointsEl = document.getElementById('points');
setupPointsPopover(pointsEl);

const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const setTasks = (fn) => store.update((s) => ({ ...s, tasks: fn(s.tasks) }));

const taskDialog = createTaskDialog(document.getElementById('task-dialog'), (fields, id) => {
    const now = clockNow();
    setTasks((tasks) =>
        id ? tasks.map((t) => (t.id === id ? updateTask(t, fields) : t)) : [...tasks, createTask(fields, { id: newId(), now })],
    );
});

const askConfirm = createConfirmDialog(document.getElementById('confirm-dialog'));
// Every popup closes when clicking outside it (like Escape)
for (const dialog of document.querySelectorAll('dialog.modal')) closeOnBackdrop(dialog);

const taskCallbacks = {
    onToggle: (id) => setTasks((tasks) => tasks.map((t) => (t.id === id ? toggleDone(t, clockNow()) : t))),
    onEdit: (id) => taskDialog.open(store.get().tasks.find((t) => t.id === id)),
    onDelete: (id) => {
        const task = store.get().tasks.find((t) => t.id === id);
        if (!task) return;
        askConfirm({
            title: 'Delete task',
            message: `"${task.title}" will be deleted for good.`,
            confirm: 'Delete',
            danger: true,
        }).then((yes) => {
            if (yes) setTasks((tasks) => tasks.filter((t) => t.id !== id));
        });
    },
};

function provincesOwned() {
    const player = map.factions.find((f) => f.isPlayer);
    return map.provinces.filter((p) => p.owner === player.id).length;
}

const dispatch = createDispatchDialog(document.getElementById('dispatch-dialog'));

/** Settlement reports already shown on this page (by id). */
const shownNews = new Set();
let settling = false;

/**
 * Settle every day that ended: credit its points, let the enemy factions
 * play, give units their moves back. The server does it for the real data
 * (in the player's time zone); test sessions do it here, with their own
 * clock. Then show what happened.
 */
async function settle() {
    if (!map || settling) return;
    settling = true;
    try {
        let items;
        if (settledByServer) {
            items = await syncDay();
            if (!items) return; // offline: try again at the next tick
        } else {
            const { state, settlement } = settleGame(store.get(), { now: clockNow(), map: baseMap });
            if (state !== store.get()) store.update(() => state);
            items = settlement ? [{ id: state.ledger.settledThrough, ...settlement }] : [];
        }
        const fresh = items.filter((n) => !shownNews.has(n.id));
        if (fresh.length && !document.getElementById('dispatch-dialog').open) {
            for (const n of fresh) shownNews.add(n.id);
            showNews(fresh);
        }
    } finally {
        settling = false;
    }
}

/** The "While you were away" report, then the replay of the attacks on the map. */
function showNews(items) {
    const granted = items.flatMap((n) => n.granted);
    const reports = items.flatMap((n) => n.reports);
    const events = reports.map((r) => ({
        province: r.province,
        from: [...new Set(r.attackers.map((o) => o.before.province))],
        captured: r.captured,
        color: map.factions[r.attackerFaction].color,
    }));
    dispatch.show(granted, reports, map, (focusId) => {
        // Shown: the server can forget these reports
        if (settledByServer) ackNews(items.at(-1).id).catch(() => {});
        view.highlight(events);
        if (focusId !== null) view.focus(focusId);
        // The replay stays until the next click (anywhere) or Escape
        const stop = (e) => {
            if (e.type === 'keydown' && e.key !== 'Escape') return;
            view.clearHighlight();
            document.removeEventListener('pointerdown', stop, true);
            document.removeEventListener('keydown', stop, true);
        };
        document.addEventListener('pointerdown', stop, true);
        document.addEventListener('keydown', stop, true);
    });
}

function renderAll() {
    const now = clockNow();
    const { tasks, ledger } = store.get();
    if (!map) return;
    const context = { provincesOwned: provincesOwned(), now };
    renderTasks(panels, tasks, now, completionGains(tasks, context), taskCallbacks);
    renderPoints(pointsEl, ledger.balance, estimateToday(tasks, context), {
        tasks,
        provincesOwned: context.provincesOwned,
        completedToday: tasks.filter((t) => isDoneToday(t, now)).length,
    });
}

store.subscribe(() => {
    if (syncMap()) view.recolor(map);
    renderAll();
    game.refresh();
});
// Due dates, streaks and day changes depend on the clock: check every minute
setInterval(() => {
    settle();
    renderAll();
}, 60 * 1000);

setupPanelToggles(document.getElementById('sidebar'));

// Test session indicator, with links to reset or leave it
if (session) {
    const badge = document.getElementById('session-badge');
    badge.querySelector('[data-session-name]').textContent = session;
    const link = (fn) => {
        const url = new URL(location.href);
        fn(url.searchParams);
        return url.pathname + url.search;
    };
    badge.querySelector('[data-session-reset]').addEventListener('click', (e) => {
        e.preventDefault();
        location.href = link((p) => p.set('reset', ''));
    });
    badge.querySelector('[data-session-exit]').addEventListener('click', (e) => {
        e.preventDefault();
        location.href = link((p) => p.delete('session'));
    });
    // Time skipping: settle the day, let the enemies play, show the dispatch
    const dateEl = badge.querySelector('[data-session-date]');
    const showDate = () => {
        const days = skippedDays();
        dateEl.textContent = `${clockNow().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}${days ? ` (+${days} d)` : ''}`;
        dateEl.title = days ? `Clock moved ${days} day${days > 1 ? 's' : ''} ahead of real time` : 'Real date';
    };
    const skip = badge.querySelector('[data-session-skip]');
    skip.hidden = !canSkip;
    skip.addEventListener('click', () => {
        skipDays(1);
        showDate();
        settle();
        renderAll();
        game.refresh();
    });
    showDate();
    badge.hidden = false;
}

for (const button of document.querySelectorAll('[data-add]')) {
    button.addEventListener('click', () => taskDialog.open(null, button.dataset.add));
}

// Mobile: the task panels replace the map instead of sitting beside it
const app = document.getElementById('app');
const viewToggle = document.getElementById('view-toggle');
viewToggle.addEventListener('click', () => {
    const open = app.classList.toggle('show-tasks');
    viewToggle.setAttribute('aria-expanded', String(open));
    viewToggle.textContent = open ? 'Map' : 'Tasks';
});

document.getElementById('regenerate').addEventListener('click', () => load(seedInput.value.trim() || 'warmind'));
document.getElementById('random').addEventListener('click', () => load(Math.random().toString(36).slice(2, 8)));
seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') load(seedInput.value.trim() || 'warmind');
});
modeButton.addEventListener('click', () => {
    mode = mode === 'political' ? 'terrain' : 'political';
    modeButton.textContent = mode === 'political' ? 'Terrain view' : 'Political view';
    view.setMode(mode);
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) game.clear();
});

renderVersion(document.getElementById('version'));

// Logged-in user and logout
document.querySelector('[data-user-name]').textContent = currentUser().username;
document.querySelector('[data-logout]').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await logout().catch(() => {});
    location.replace('/login/');
});
// Save indicator next to the user name
const saveEl = document.querySelector('[data-save-status]');
const SAVE_LABELS = {
    saved: ['Saved', 'Your game is saved on the server.'],
    saving: ['Saving…', 'Saving your game.'],
    offline: ['Offline', 'Could not reach the server: your changes are kept and will be saved when it is back.'],
    conflict: ['Reloading…', 'Your game was saved from another device: loading that version.'],
    local: ['Test session', 'Test sessions are kept in this browser only.'],
};
saveStatus.subscribe((s) => {
    const [label, title] = SAVE_LABELS[s];
    saveEl.textContent = label;
    saveEl.title = title;
    saveEl.dataset.state = s;
});

// Seed controls: test sessions only (they would start a new campaign)
for (const el of document.querySelectorAll('[data-dev-only]')) el.hidden = !session;

// The campaign's own seed; a new campaign gets a random one
const randomSeed = () => Math.random().toString(36).slice(2, 8);
const savedSeed = store.get().campaign?.seed;
load(session ? new URLSearchParams(location.search).get('seed') || savedSeed || 'warmind' : savedSeed || randomSeed());
