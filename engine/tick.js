/**
 * @file Daily turn: points, AI, motivation.
 *
 * Days are settled lazily: whenever the campaign is opened, every day that
 * ended since the last settlement is processed once, in order. For now a
 * day only grants its action points; AI turns and unit motivation will
 * hook in here.
 */

import { computeDailyPoints } from './points.js';
import { dayKey, shiftDay } from './tasks.js';

/**
 * @typedef {object} Ledger
 * @property {number} balance Action points available.
 * @property {string|null} settledThrough Last day (YYYY-MM-DD) already granted;
 *   null for a new campaign.
 */

/** Last instant of a local day. */
export function endOfDay(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999);
}

/**
 * Grant the points of every day that ended since the last settlement.
 * Each day is judged on the task list as it stood at the end of that day.
 * A new campaign starts settling from today (no back-pay).
 * @param {Ledger} ledger
 * @param {import('./tasks.js').Task[]} tasks
 * @param {{ provincesOwned: number, now: Date }} context
 * @returns {{ ledger: Ledger, granted: { day: string, points: number }[] }}
 */
export function settleDays(ledger, tasks, { provincesOwned, now }) {
    const yesterday = shiftDay(dayKey(now), -1);
    if (ledger.settledThrough === null) return { ledger: { ...ledger, settledThrough: yesterday }, granted: [] };

    const granted = [];
    let balance = ledger.balance;
    for (let day = shiftDay(ledger.settledThrough, 1); day <= yesterday; day = shiftDay(day, 1)) {
        const points = computeDailyPoints(tasks, { provincesOwned, now: endOfDay(day) }).total;
        balance += points;
        granted.push({ day, points });
    }
    const settledThrough = granted.length ? yesterday : ledger.settledThrough;
    return { ledger: { balance, settledThrough }, granted };
}

/**
 * Points the current day will grant if nothing changes before it ends.
 * @param {import('./tasks.js').Task[]} tasks
 * @param {{ provincesOwned: number, now: Date }} context
 */
export function estimateToday(tasks, { provincesOwned, now }) {
    // Judged at the end of the day: a task due later today and still
    // unfinished then counts as overdue, exactly as the settlement will see it
    return computeDailyPoints(tasks, { provincesOwned, now: endOfDay(dayKey(now)) });
}
