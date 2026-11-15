import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { start, register } from './helpers/server.js';
import { validateSave, guardSave, MAX_SAVE_BYTES } from '../server/routes/campaign.js';
import { generateMap } from '../engine/mapgen.js';
import { deployUnits } from '../engine/units.js';

const game = (extra = {}) => ({
    tasks: [
        {
            id: 't1',
            title: 'Essay',
            severity: 3,
            recurring: false,
            dueAt: '2026-11-20T22:59:00.000Z',
            createdAt: '2026-11-15T10:00:00.000Z',
            completedAt: null,
            doneOn: [],
        },
    ],
    ledger: { balance: 12, settledThrough: '2026-11-14' },
    campaign: { seed: 'abc123', units: [], nextId: 1, numbers: {} },
    ...extra,
});

describe('validateSave', () => {
    it('accepts a game and a game without a campaign yet', () => {
        expect(validateSave(game())).toBeNull();
        expect(validateSave(game({ campaign: null }))).toBeNull();
    });

    it('refuses malformed saves', () => {
        expect(validateSave(null)).toMatch(/object/);
        expect(validateSave([])).toMatch(/object/);
        expect(validateSave(game({ tasks: 'x' }))).toMatch(/tasks/);
        expect(validateSave(game({ ledger: {} }))).toMatch(/ledger/);
        expect(validateSave(game({ campaign: { units: [] } }))).toMatch(/campaign/);
    });
});

describe('save API', () => {
    let srv;
    let c;
    beforeEach(async () => {
        srv = await start();
        c = srv.client();
        await register(c);
    });
    afterEach(() => srv.close());

    it('saves with POST too (hosting firewalls may block PUT)', async () => {
        const first = await c.post('/api/save', { data: game(), version: 0 });
        expect(first.status).toBe(200);
        expect(first.body.version).toBe(1);
        expect((await c.post('/api/save', { data: game(), version: 0 })).status).toBe(409);
        expect((await srv.client().post('/api/save', { data: game(), version: 0 })).status).toBe(401);
    });

    it('needs a login', async () => {
        const anon = srv.client();
        expect((await anon.get('/api/save')).status).toBe(401);
        expect((await anon.put('/api/save', { data: game(), version: 0 })).status).toBe(401);
    });

    it('starts empty, then stores and returns the game with a growing version', async () => {
        expect((await c.get('/api/save')).body).toEqual({ data: null, version: 0, updatedAt: null, news: [] });
        const first = await c.put('/api/save', { data: game(), version: 0 });
        expect(first.status).toBe(200);
        expect(first.body.version).toBe(1);
        const second = await c.put('/api/save', { data: game({ tasks: [] }), version: 1 });
        expect(second.body.version).toBe(2);
        const loaded = (await c.get('/api/save')).body;
        // (Loading also starts the day count of the campaign: one more version)
        expect(loaded).toMatchObject({ data: { tasks: [] } });
        expect(loaded.version).toBeGreaterThanOrEqual(2);
        expect(loaded.updatedAt).toEqual(expect.any(String));
    });

    it('refuses a save based on an outdated version and returns the current one', async () => {
        await c.put('/api/save', { data: game(), version: 0 });
        await c.put('/api/save', { data: game({ tasks: [] }), version: 1 });
        // A second device still on version 1
        const stale = await c.put('/api/save', { data: game(), version: 1 });
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ version: 2, data: { tasks: [] } });
        // Two "first saves" at once: only one wins
        const other = srv.client();
        await register(other, 'second');
        const a = await other.put('/api/save', { data: game(), version: 0 });
        const b = await other.put('/api/save', { data: game(), version: 0 });
        expect([a.status, b.status]).toEqual([200, 409]);
    });

    it('keeps each user’s game separate', async () => {
        await c.put('/api/save', { data: game(), version: 0 });
        const other = srv.client();
        await register(other, 'second');
        expect((await other.get('/api/save')).body.data).toBeNull();
    });

    it('validates the body: version, shape, size and content type', async () => {
        expect((await c.put('/api/save', { data: game(), version: -1 })).status).toBe(400);
        expect((await c.put('/api/save', { data: game({ tasks: null }), version: 0 })).status).toBe(400);
        const huge = game({ tasks: [{ title: 'x'.repeat(MAX_SAVE_BYTES) }] });
        expect((await c.put('/api/save', { data: huge, version: 0 })).status).toBe(413);
        expect((await c.put('/api/save', 'data=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    });

    it('deletes the save with the account', async () => {
        await c.put('/api/save', { data: game(), version: 0 });
        srv.db.raw.prepare('DELETE FROM users').run();
        expect(srv.db.raw.prepare('SELECT COUNT(*) AS n FROM saves').get().n).toBe(0);
    });
});

describe('guardSave', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const stored = game({ ledger: { balance: 10, settledThrough: '2026-11-14' } });

    it('only lets the balance go down and keeps the server\u2019s settled day', () => {
        expect(guardSave(game({ ledger: { balance: 99, settledThrough: '2030-01-01' } }), stored, now).ledger).toEqual({
            balance: 10,
            settledThrough: '2026-11-14',
        });
        expect(guardSave(game({ ledger: { balance: 4, settledThrough: null } }), stored, now).ledger).toEqual({
            balance: 4,
            settledThrough: '2026-11-14',
        });
    });

    it('starts a new game from zero', () => {
        expect(guardSave(game({ ledger: { balance: 500, settledThrough: '2026-11-14' } }), null, now).ledger).toEqual({
            balance: 0,
            settledThrough: null,
        });
    });

    it('brings task dates back from the future', () => {
        const future = '2027-01-01T00:00:00.000Z';
        const [t] = guardSave(game({ tasks: [{ ...game().tasks[0], createdAt: future, completedAt: future }] }), stored, now).tasks;
        expect(t.createdAt).toBe(now.toISOString());
        expect(t.completedAt).toBe(now.toISOString());
        // A few minutes of clock difference are fine
        const soon = new Date(now.getTime() + 60_000).toISOString();
        expect(guardSave(game({ tasks: [{ ...game().tasks[0], completedAt: soon }] }), stored, now).tasks[0].completedAt).toBe(soon);
    });
});

describe('server settlement', () => {
    const map = generateMap({ seed: 'server-turn' });
    const campaign = deployUnits(map);
    let clock;
    let srv;
    let c;

    beforeEach(async () => {
        clock = new Date('2026-11-15T12:00:00Z');
        srv = await start({ now: () => clock });
        c = srv.client();
        await register(c);
    });
    afterEach(() => srv.close());

    /** A started game (first save, then the first load starts the day count). */
    async function startGame(timeZone = 'UTC') {
        await c.put('/api/save', { data: game({ campaign, timeZone, tasks: [] }), version: 0 });
        return (await c.get('/api/save')).body;
    }

    it('starts counting days at the first load, without back-pay', async () => {
        const loaded = await startGame();
        expect(loaded.data.ledger).toEqual({ balance: 0, settledThrough: '2026-11-14' });
        expect(loaded.news).toEqual([]);
    });

    it('settles the days that ended: points, enemy turns, a report to show', async () => {
        const before = await startGame();
        clock = new Date('2026-11-17T09:00:00Z');
        const after = (await c.post('/api/save/settle', {})).body;
        expect(after.version).toBe(before.version + 1);
        expect(after.data.ledger.settledThrough).toBe('2026-11-16');
        expect(after.data.ledger.balance).toBeGreaterThan(0);
        expect(after.data.campaign.battles).toBeGreaterThan(campaign.battles);
        expect(after.news).toHaveLength(1);
        expect(after.news[0].id).toBe('2026-11-16');
        expect(after.news[0].granted.map((g) => g.day)).toEqual(['2026-11-15', '2026-11-16']);
        // Nothing more to do the same day
        expect((await c.get('/api/save')).body.version).toBe(after.version);
    });

    it('makes a client save based on the pre-settlement version conflict', async () => {
        const before = await startGame();
        clock = new Date('2026-11-16T09:00:00Z');
        await c.post('/api/save/settle', {});
        expect((await c.put('/api/save', { data: before.data, version: before.version })).status).toBe(409);
    });

    it('cannot be skipped by a client: saves keep the server\u2019s ledger', async () => {
        const before = await startGame();
        const cheat = { ...before.data, ledger: { balance: 1000, settledThrough: '2026-01-01' } };
        await c.put('/api/save', { data: cheat, version: before.version });
        expect((await c.get('/api/save')).body.data.ledger).toEqual(before.data.ledger);
    });

    it('uses the player\u2019s time zone for midnight', async () => {
        // 12:00 UTC on the 15th is already the 16th in Kiribati (UTC+14), still the 15th in Samoa (UTC-11)
        expect((await startGame('Pacific/Kiritimati')).data.ledger.settledThrough).toBe('2026-11-15');
        const other = srv.client();
        await register(other, 'samoa');
        await other.put('/api/save', { data: game({ campaign, timeZone: 'Pacific/Pago_Pago', tasks: [] }), version: 0 });
        expect((await other.get('/api/save')).body.data.ledger.settledThrough).toBe('2026-11-14');
        // An unknown zone falls back to UTC
        const third = srv.client();
        await register(third, 'nowhere');
        await third.put('/api/save', { data: game({ campaign, timeZone: 'Mars/Olympus', tasks: [] }), version: 0 });
        expect((await third.get('/api/save')).body.data.ledger.settledThrough).toBe('2026-11-14');
    });

    it('drops the reports the app has shown', async () => {
        await startGame();
        clock = new Date('2026-11-16T09:00:00Z');
        await c.get('/api/save');
        clock = new Date('2026-11-17T09:00:00Z');
        const loaded = (await c.get('/api/save')).body;
        expect(loaded.news.map((n) => n.id)).toEqual(['2026-11-15', '2026-11-16']);
        expect((await c.post('/api/save/news/ack', { upTo: '2026-11-15' })).status).toBe(204);
        expect((await c.get('/api/save')).body.news.map((n) => n.id)).toEqual(['2026-11-16']);
        expect((await c.post('/api/save/news/ack', {})).status).toBe(400);
    });
});
