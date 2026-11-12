/**
 * @file Bootstrap: login check, load campaign, render.
 *
 * Current state: map prototype plus the todo list (saved in localStorage).
 * The seed is read from the URL (?seed=...) so a given map can be shared
 * and reloaded.
 */

import { generateMap } from '/engine/mapgen.js';
import { deployUnits, ownedMap, refreshMoves } from '/engine/units.js';
import { createMapView } from './ui/map.js';
import { createGameController } from './game.js';
import { createBattleDialog } from './ui/battle.js';
import { createDispatchDialog } from './ui/dispatch.js';
import { playDays } from '/engine/ai.js';
import { renderVersion, renderPoints, setupPointsPopover } from './ui/topbar.js';
import { renderTasks, setupPanelToggles } from './ui/tasks.js';
import { createTaskDialog } from './ui/modals.js';
import { store, session } from './store.js';
import { now as clockNow, canSkip, skipDays, skippedDays } from './clock.js';
import { createTask, updateTask, toggleDone, isDoneToday } from '/engine/tasks.js';
import { settleDays, estimateToday, completionGains } from '/engine/tick.js';

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
    const url = new URL(location.href);
    url.searchParams.set('seed', seed);
    history.replaceState(null, '', url);

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
    setTasks((tasks) => (id ? tasks.map((t) => (t.id === id ? updateTask(t, fields) : t)) : [...tasks, createTask(fields, { id: newId(), now })]));
});

const taskCallbacks = {
    onToggle: (id) => setTasks((tasks) => tasks.map((t) => (t.id === id ? toggleDone(t, clockNow()) : t))),
    onEdit: (id) => taskDialog.open(store.get().tasks.find((t) => t.id === id)),
    onDelete: (id) => {
        const task = store.get().tasks.find((t) => t.id === id);
        if (task && confirm(`Delete "${task.title}"?`)) setTasks((tasks) => tasks.filter((t) => t.id !== id));
    },
};

function provincesOwned() {
    const player = map.factions.find((f) => f.isPlayer);
    return map.provinces.filter((p) => p.owner === player.id).length;
}

const dispatch = createDispatchDialog(document.getElementById('dispatch-dialog'));

/**
 * Settle every day that ended since the last visit: credit its points, then
 * let the enemy factions play their turn of that day. Shows a summary.
 */
function settle() {
    if (!map) return;
    const { tasks, ledger, campaign } = store.get();
    const result = settleDays(ledger, tasks, { provincesOwned: provincesOwned(), now: clockNow() });
    if (result.ledger.settledThrough === ledger.settledThrough) return;
    const before = map;
    const enemy = campaign && result.granted.length ? playDays(campaign, baseMap, result.granted.map((g) => g.day)) : { campaign, reports: [] };
    // A new day starts: every unit gets its move back
    const today = enemy.campaign && result.granted.length ? refreshMoves(enemy.campaign) : enemy.campaign;
    store.update((s) => ({ ...s, ledger: result.ledger, campaign: today }));
    if (!result.granted.length) return;
    // When the report closes: replay the day's attacks on the map, and show
    // the province picked in the report, if any
    const events = enemy.reports.map((r) => ({
        province: r.province,
        from: [...new Set(r.attackers.map((o) => o.before.province))],
        captured: r.captured,
        color: before.factions[r.attackerFaction].color,
    }));
    dispatch.show(result.granted, enemy.reports, before, (focusId) => {
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
load(new URLSearchParams(location.search).get('seed') || 'warmind');
