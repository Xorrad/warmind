/**
 * @file Test sessions: `?session=<name>` keeps its data under its own
 * localStorage keys, so the real data is never touched. `&reset` wipes the
 * session's data (then drops itself from the URL so a reload does not wipe
 * it again).
 */

const params = new URLSearchParams(location.search);

/** Name of the test session, or null for the real data. */
export const session = params.get('session')?.replace(/[^\w-]/g, '') || null;

/** Prefix of every localStorage key of the current data set. */
export const prefix = session ? `warmind.session.${session}.` : 'warmind.';

if (session && params.has('reset')) {
    try {
        for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    } catch {
        // Nothing stored anyway
    }
    params.delete('reset');
    history.replaceState(null, '', `${location.pathname}?${params}`);
}
