/**
 * @file Run code in a player's time zone.
 *
 * The engine's day boundaries use the runtime's local time (Date getters).
 * Node applies a change of process.env.TZ immediately, so settling a day in
 * the player's zone is: switch TZ, run the synchronous settlement, switch
 * back. Nothing asynchronous may happen in between (single thread).
 */

/** Whether `tz` is an IANA time zone name this runtime knows. */
export function isTimeZone(tz) {
    if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * Call `fn` with the process in time zone `tz` (UTC when invalid).
 * @template T
 * @param {string|undefined} tz
 * @param {() => T} fn Must be synchronous.
 * @returns {T}
 */
export function withTimeZone(tz, fn) {
    const previous = process.env.TZ;
    process.env.TZ = isTimeZone(tz) ? tz : 'UTC';
    try {
        return fn();
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
}
