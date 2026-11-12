/**
 * @file Where the current data lives in localStorage: under the logged-in
 * user's prefix, and for test sessions (`?session=<name>`) under their own
 * keys, so the real data is never touched. `&reset` wipes the
 * session's data (then drops itself from the URL so a reload does not wipe
 * it again).
 */

import { currentUser } from './user.js';

const params = new URLSearchParams(location.search);

/** Name of the test session, or null for the real data. */
export const session = params.get('session')?.replace(/[^\w-]/g, '') || null;

const user = currentUser();
if (!user) throw new Error('session.js needs the logged-in user (set by main.js).');

/** Prefix of every localStorage key of the current data set: per user, then per test session. */
export const prefix = `warmind.u${user.id}.${session ? `session.${session}.` : ''}`;

// Data saved before accounts existed ("warmind.tasks.v1"…) goes to the
// first account that logs in on this browser
const LEGACY = ['tasks.v1', 'ledger.v1', 'campaign.v1'];
try {
    if (!session && !localStorage.getItem('warmind.legacyClaimed')) {
        for (const name of LEGACY) {
            const old = localStorage.getItem(`warmind.${name}`);
            if (old !== null && localStorage.getItem(prefix + name) === null) localStorage.setItem(prefix + name, old);
            localStorage.removeItem(`warmind.${name}`);
        }
        localStorage.setItem('warmind.legacyClaimed', String(user.id));
    }
} catch {
    // Storage unavailable: nothing to move
}

if (session && params.has('reset')) {
    try {
        for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    } catch {
        // Nothing stored anyway
    }
    params.delete('reset');
    history.replaceState(null, '', `${location.pathname}?${params}`);
}
