/**
 * @file The game's clock. In a test session it can be moved forward by
 * whole days (saved with the session) to try daily settlement, streaks and
 * enemy turns without waiting; with the real data it is always real time.
 */

import { session, prefix } from './session.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY = `${prefix}clock.v1`;

let offset = 0;
if (session) {
    try {
        offset = Number(localStorage.getItem(KEY)) || 0;
    } catch {
        offset = 0;
    }
}

/** Whether the clock can be moved (test sessions only). */
export const canSkip = session !== null;

/** Current game time. Use instead of `new Date()` everywhere in the client. */
export function now() {
    return new Date(Date.now() + offset);
}

/** Days the clock is ahead of real time. */
export function skippedDays() {
    return Math.round(offset / DAY_MS);
}

/** Move the clock forward by `days` days (test sessions only). */
export function skipDays(days = 1) {
    if (!canSkip) return;
    offset += days * DAY_MS;
    try {
        localStorage.setItem(KEY, String(offset));
    } catch {
        // Kept for this page only
    }
}
