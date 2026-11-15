/**
 * @file Saved game routes: the player's tasks, points ledger and campaign,
 * stored as one JSON document per user, and the daily settlement.
 *
 *   GET  /api/save              settle, then { data, version, updatedAt, news }
 *   POST /api/save/settle       same (the app calls it every minute)
 *   PUT  /api/save              { data, version } -> { version, updatedAt }
 *   POST /api/save/news/ack     { upTo } -> remove the reports shown
 *
 * `version` is the version the client's data is based on (0 for the first
 * save). If the server saved in between (another device, or a settlement),
 * it answers 409 with its current save instead of overwriting it.
 *
 * The server owns the day: it settles every day that ended (points, enemy
 * turns, moves back) in the player's time zone (data.timeZone), keeps the
 * report of each settlement in `news` until the app has shown it, and does
 * not let a save raise the points balance, change the last settled day or
 * date tasks in the future. Spending actions still run in the browser.
 */

import express from 'express';
import { requireAuth } from '../auth.js';
import { settleGame } from '../../engine/turn.js';
import { generateMap } from '../../engine/mapgen.js';
import { withTimeZone } from '../timezone.js';

/** Largest save accepted, in bytes (a busy campaign is well under 100 KB). */
export const MAX_SAVE_BYTES = 1024 * 1024;
/** Settlement reports kept at most (one per settlement). */
const MAX_NEWS = 30;
/** Clock difference tolerated on client timestamps. */
const SKEW_MS = 5 * 60 * 1000;

/** Check the shape of a saved game; returns an error message or null. */
export function validateSave(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'The save must be an object.';
    if (!Array.isArray(data.tasks)) return 'tasks must be a list.';
    if (!data.ledger || typeof data.ledger !== 'object' || typeof data.ledger.balance !== 'number')
        return 'ledger.balance must be a number.';
    if (
        data.campaign !== null &&
        (typeof data.campaign !== 'object' || !Array.isArray(data.campaign?.units) || typeof data.campaign.seed !== 'string')
    ) {
        return 'campaign must be null or have a seed and units.';
    }
    if (data.timeZone !== undefined && typeof data.timeZone !== 'string') return 'timeZone must be a string.';
    return null;
}

/**
 * Enforce the server's authority on a save sent by a client: the points
 * balance can only go down (actions spend it, settlements add to it), the
 * last settled day is the server's, and task dates cannot be in the future.
 * @param {object} data From the client (validated).
 * @param {object|null} stored The current save, or null for a first save.
 * @param {Date} now
 */
export function guardSave(data, stored, now) {
    const limit = now.getTime() + SKEW_MS;
    const notFuture = (iso) => (typeof iso === 'string' && Date.parse(iso) > limit ? now.toISOString() : iso);
    const tasks = data.tasks.map((t) =>
        t && typeof t === 'object'
            ? { ...t, createdAt: notFuture(t.createdAt), completedAt: t.completedAt === null ? null : notFuture(t.completedAt) }
            : t,
    );
    // A new game starts from zero; afterwards only settlements add points
    const ledger = stored
        ? { balance: Math.min(data.ledger.balance, stored.ledger.balance), settledThrough: stored.ledger.settledThrough ?? null }
        : { balance: 0, settledThrough: null };
    return { ...data, tasks, ledger };
}

/**
 * @param {ReturnType<typeof import('../db.js').openDb>} db
 * @param {{ now?: () => Date }} [options] `now` is the server clock (tests move it).
 */
export function createSaveRouter(db, { now = () => new Date() } = {}) {
    const router = express.Router();
    router.use(requireAuth(db));

    // Generating a map takes ~50 ms: keep the latest few
    const maps = new Map();
    const mapFor = (seed) => {
        if (!maps.has(seed)) {
            if (maps.size >= 20) maps.delete(maps.keys().next().value);
            maps.set(seed, generateMap({ seed }));
        }
        return maps.get(seed);
    };

    const view = (row) =>
        row
            ? { data: JSON.parse(row.data), version: row.version, updatedAt: row.updatedAt, news: JSON.parse(row.news) }
            : { data: null, version: 0, updatedAt: null, news: [] };

    /** Settle the user's game if a day ended; returns the (new) stored row. */
    function settle(userId) {
        return db.transaction(() => {
            const row = db.getSave(userId);
            if (!row) return row;
            const data = JSON.parse(row.data);
            if (!data.campaign) return row;
            const result = withTimeZone(data.timeZone, () =>
                settleGame(
                    { tasks: data.tasks, ledger: data.ledger, campaign: data.campaign },
                    { now: now(), map: mapFor(data.campaign.seed) },
                ),
            );
            if (result.state.ledger.settledThrough === data.ledger.settledThrough) return row;
            const saved = db.putSave(userId, JSON.stringify({ ...data, ...result.state }), row.version);
            if (!saved.ok) return db.getSave(userId);
            if (result.settlement) {
                const news = [...JSON.parse(row.news), { id: result.state.ledger.settledThrough, ...result.settlement }].slice(-MAX_NEWS);
                db.setNews(userId, JSON.stringify(news));
            }
            return db.getSave(userId);
        });
    }

    const settled = (req, res) => res.set('Cache-Control', 'no-store').json(view(settle(req.user.id)));
    router.get('/', settled);
    router.post('/settle', settled);

    router.put('/', (req, res) => {
        const { data, version } = req.body ?? {};
        if (!Number.isSafeInteger(version) || version < 0) return res.status(400).json({ error: 'version must be a whole number.' });
        const invalid = validateSave(data);
        if (invalid) return res.status(400).json({ error: invalid });
        const row = db.getSave(req.user.id);
        const json = JSON.stringify(guardSave(data, row ? JSON.parse(row.data) : null, now()));
        if (Buffer.byteLength(json) > MAX_SAVE_BYTES) return res.status(413).json({ error: 'This save is too large.' });
        const result = db.putSave(req.user.id, json, version);
        if (!result.ok)
            return res.status(409).json({ error: 'Your game was saved elsewhere in the meantime.', ...view(db.getSave(req.user.id)) });
        res.json({ version: result.version, updatedAt: result.updatedAt });
    });

    // The app showed the reports up to this settlement: drop them
    router.post('/news/ack', (req, res) => {
        const { upTo } = req.body ?? {};
        if (typeof upTo !== 'string') return res.status(400).json({ error: 'upTo must be a settlement id.' });
        const row = db.getSave(req.user.id);
        if (row) db.setNews(req.user.id, JSON.stringify(JSON.parse(row.news).filter((n) => n.id > upTo)));
        res.status(204).end();
    });

    return router;
}
