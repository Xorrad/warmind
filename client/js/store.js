/**
 * @file Current game state with subscribe/notify.
 *
 * Tasks, the points ledger and the campaign (units) are saved in
 * localStorage for now; the campaign API replaces this once accounts exist.
 *
 * Test sessions (see session.js) keep their data under separate keys. The
 * "demo" session is filled with generated tasks the first time (or again
 * after a reset); any other name starts empty.
 */

import { generateDemoData } from '/engine/demo.js';
import { session, prefix } from './session.js';
import { now } from './clock.js';

export { session };

const TASKS_KEY = `${prefix}tasks.v1`;
const LEDGER_KEY = `${prefix}ledger.v1`;
const CAMPAIGN_KEY = `${prefix}campaign.v1`;

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

function load(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

function save(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Private mode or storage full: keep working in memory
    }
}

/** @returns {import('/engine/tasks.js').Task[]} */
function loadTasks() {
    const tasks = load(TASKS_KEY, []);
    // Drop fields from older versions (priority was removed)
    return Array.isArray(tasks) ? tasks.map(({ priority: _priority, ...task }) => task) : [];
}

/** @returns {import('/engine/tick.js').Ledger} */
function loadLedger() {
    const ledger = load(LEDGER_KEY, null);
    return ledger && typeof ledger.balance === 'number' ? ledger : { balance: 0, settledThrough: null };
}

/**
 * Units of the current map, or null: main.js deploys new ones when there is
 * none yet or they belong to another map seed.
 * @returns {import('/engine/units.js').Campaign|null}
 */
function loadCampaign() {
    const campaign = load(CAMPAIGN_KEY, null);
    return campaign && Array.isArray(campaign.units) ? campaign : null;
}

function initialState() {
    if (session === 'demo' && load(TASKS_KEY, null) === null) {
        return { ...generateDemoData({ now: now() }), campaign: null };
    }
    return { tasks: loadTasks(), ledger: loadLedger(), campaign: loadCampaign() };
}

export const store = createStore(initialState());
store.subscribe((s) => {
    save(TASKS_KEY, s.tasks);
    save(LEDGER_KEY, s.ledger);
    save(CAMPAIGN_KEY, s.campaign);
});

// Save the generated demo data right away
save(TASKS_KEY, store.get().tasks);
save(LEDGER_KEY, store.get().ledger);
