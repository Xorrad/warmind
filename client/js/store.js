/**
 * @file Current game state with subscribe/notify.
 *
 * Tasks and the points ledger are saved in localStorage for now; the
 * campaign API replaces this once accounts exist.
 */

const TASKS_KEY = 'warmind.tasks.v1';
const LEDGER_KEY = 'warmind.ledger.v1';

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
    return Array.isArray(tasks) ? tasks.map(({ priority, ...task }) => task) : [];
}

/** @returns {import('/engine/tick.js').Ledger} */
function loadLedger() {
    const ledger = load(LEDGER_KEY, null);
    return ledger && typeof ledger.balance === 'number' ? ledger : { balance: 0, settledThrough: null };
}

export const store = createStore({ tasks: loadTasks(), ledger: loadLedger() });
store.subscribe((s) => {
    save(TASKS_KEY, s.tasks);
    save(LEDGER_KEY, s.ledger);
});
