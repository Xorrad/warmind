/**
 * @file Bootstrap: login check, load campaign, render.
 *
 * Current state: map prototype plus the todo list (saved in localStorage).
 * The seed is read from the URL (?seed=...) so a given map can be shared
 * and reloaded.
 */

import { generateMap } from '/engine/mapgen.js';
import { TERRAINS } from '/engine/config.js';
import { createMapView } from './ui/map.js';
import { renderVersion, renderPoints } from './ui/topbar.js';
import { renderTasks, setupPanelToggles } from './ui/tasks.js';
import { createTaskDialog } from './ui/modals.js';
import { store, session } from './store.js';
import { createTask, updateTask, toggleDone } from '/engine/tasks.js';
import { settleDays, estimateToday, completionGains } from '/engine/tick.js';

const seedInput = /** @type {HTMLInputElement} */ (document.getElementById('seed'));
const modeButton = document.getElementById('mode');
const info = document.getElementById('province-info');

let map = null;
let mode = 'political';

const view = createMapView(document.getElementById('map'), { onSelect: showProvince });

function load(seed) {
    seedInput.value = seed;
    const url = new URL(location.href);
    url.searchParams.set('seed', seed);
    history.replaceState(null, '', url);

    map = generateMap({ seed });
    view.render(map);
    settle();
    renderAll();
}

/* ---------- Tasks ---------- */

const panels = {
    todo: document.getElementById('todo-list'),
    streaks: document.getElementById('streak-list'),
    completed: document.getElementById('completed-list'),
};
const pointsEl = document.getElementById('points');

const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const setTasks = (fn) => store.update((s) => ({ ...s, tasks: fn(s.tasks) }));

const taskDialog = createTaskDialog(document.getElementById('task-dialog'), (fields, id) => {
    const now = new Date();
    setTasks((tasks) => (id ? tasks.map((t) => (t.id === id ? updateTask(t, fields) : t)) : [...tasks, createTask(fields, { id: newId(), now })]));
});

const taskCallbacks = {
    onToggle: (id) => setTasks((tasks) => tasks.map((t) => (t.id === id ? toggleDone(t, new Date()) : t))),
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

/** Credit the points of every day that ended since the last visit. */
function settle() {
    if (!map) return;
    const { tasks, ledger } = store.get();
    const result = settleDays(ledger, tasks, { provincesOwned: provincesOwned(), now: new Date() });
    if (result.ledger.settledThrough !== ledger.settledThrough) store.update((s) => ({ ...s, ledger: result.ledger }));
}

function renderAll() {
    const now = new Date();
    const { tasks, ledger } = store.get();
    if (!map) return;
    const context = { provincesOwned: provincesOwned(), now };
    renderTasks(panels, tasks, now, completionGains(tasks, context), taskCallbacks);
    renderPoints(pointsEl, ledger.balance, estimateToday(tasks, context));
}

store.subscribe(renderAll);
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

function showProvince(p) {
    if (!p) {
        info.hidden = true;
        return;
    }
    const names = (ids) => ids.map((n) => map.provinces[n].name).join(', ');
    if (p.owner === -1) {
        info.innerHTML = `
        <h2>${p.name}</h2>
        <dl>
            <dt>Terrain</dt><dd><span class="swatch" style="background:${TERRAINS[p.terrain].color}"></span>${TERRAINS[p.terrain].label} (impassable)</dd>
            <dt>Borders</dt><dd>${names(p.borders)}</dd>
        </dl>`;
        info.hidden = false;
        return;
    }
    const owner = map.factions[p.owner];
    const neighbourNames = names(p.neighbours);
    info.innerHTML = `
        <h2>${p.name}${p.isCapital ? ' ★' : ''}</h2>
        <dl>
            <dt>Owner</dt><dd><span class="swatch" style="background:${owner.color}"></span>${owner.name}</dd>
            <dt>Terrain</dt><dd><span class="swatch" style="background:${TERRAINS[p.terrain].color}"></span>${TERRAINS[p.terrain].label}</dd>
            <dt>Neighbours</dt><dd>${neighbourNames}</dd>
        </dl>`;
    info.hidden = false;
}

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
    if (e.key === 'Escape') view.select(null);
});

renderVersion(document.getElementById('version'));
load(new URLSearchParams(location.search).get('seed') || 'warmind');
