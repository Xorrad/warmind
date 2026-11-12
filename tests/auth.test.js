import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { createApp, DEFAULTS } from '../server/app.js';
import { openDb } from '../server/db.js';
import { leadingZeroBits, createChallenges } from '../server/antibot.js';
import { validateCredentials } from '../server/auth.js';

/** Start the app on a free port; returns a tiny client keeping its cookie. */
async function start(overrides = {}) {
    const db = openDb(':memory:');
    const app = createApp({
        db,
        secret: 'test-secret',
        bcryptRounds: 4,
        pow: { bits: 8, minAgeMs: 0, maxAgeMs: 60_000 },
        ...overrides,
    });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    const client = () => {
        let cookie = '';
        const request = async (method, path, body, headers = {}) => {
            const res = await fetch(base + path, {
                method,
                headers: {
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...headers,
                },
                body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
            });
            const set = res.headers.get('set-cookie');
            if (set) cookie = set.split(';')[0];
            const text = await res.text();
            return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, setCookie: set };
        };
        return {
            get: (p) => request('GET', p),
            post: (p, b, h) => request('POST', p, b, h),
            get cookie() {
                return cookie;
            },
        };
    };
    return { db, app, client, close: () => new Promise((r) => (app.close(), server.close(r))) };
}

/** Solve a challenge like the browser does. */
function solve(challenge) {
    for (let nonce = 0; ; nonce++) {
        const hash = crypto.createHash('sha256').update(`${challenge.salt}:${nonce}`).digest();
        if (leadingZeroBits(hash) >= challenge.bits) return nonce;
    }
}

async function register(c, username = 'general', password = 'correct horse battery', extra = {}) {
    const challenge = (await c.get('/api/auth/challenge')).body;
    return c.post('/api/auth/register', { username, password, challenge, nonce: solve(challenge), website: '', ...extra });
}

describe('credentials', () => {
    it('validates usernames and passwords', () => {
        expect(validateCredentials('general', 'long enough pass')).toBeNull();
        expect(validateCredentials('ab', 'long enough pass')).toMatch(/Usernames/);
        expect(validateCredentials('bad name!', 'long enough pass')).toMatch(/Usernames/);
        expect(validateCredentials('general', 'short')).toMatch(/at least/);
        expect(validateCredentials('general', 'x'.repeat(73))).toMatch(/72 bytes/);
        expect(validateCredentials('general', 'my-general-pass')).toMatch(/username/);
    });

    it('counts leading zero bits', () => {
        expect(leadingZeroBits(Buffer.from([0, 0x0f]))).toBe(12);
        expect(leadingZeroBits(Buffer.from([0x80]))).toBe(0);
        expect(leadingZeroBits(Buffer.from([0, 0]))).toBe(16);
    });
});

describe('auth API', () => {
    let srv;
    beforeEach(async () => (srv = await start()));
    afterEach(() => srv.close());

    it('registers, keeps the session, logs out and logs back in', async () => {
        const c = srv.client();
        const reg = await register(c);
        expect(reg.status).toBe(201);
        expect(reg.body.user).toMatchObject({ username: 'general' });
        expect(reg.body.user).not.toHaveProperty('passwordHash');
        expect(reg.setCookie).toMatch(/HttpOnly/i);
        expect(reg.setCookie).toMatch(/SameSite=Lax/i);

        expect((await c.get('/api/auth/me')).body.user.username).toBe('general');
        expect((await c.post('/api/auth/logout', {})).status).toBe(204);
        expect((await c.get('/api/auth/me')).status).toBe(401);

        const login = await c.post('/api/auth/login', { username: 'GENERAL', password: 'correct horse battery', website: '' });
        expect(login.status).toBe(200);
        expect((await c.get('/api/auth/me')).body.user.username).toBe('general');
    });

    it('stores a bcrypt hash, never the password', async () => {
        await register(srv.client());
        const row = srv.db.raw.prepare('SELECT password_hash FROM users').get();
        expect(row.password_hash).toMatch(/^\$2[aby]\$/);
        expect(row.password_hash).not.toContain('correct horse');
    });

    it('gives a new session id at login (no fixation)', async () => {
        const c = srv.client();
        await c.get('/api/auth/challenge');
        await register(c);
        const before = c.cookie;
        await c.post('/api/auth/logout', {});
        await c.post('/api/auth/login', { username: 'general', password: 'correct horse battery' });
        expect(c.cookie).not.toBe(before);
    });

    it('refuses taken (case-insensitive) and invalid usernames', async () => {
        await register(srv.client(), 'General');
        expect((await register(srv.client(), 'general')).status).toBe(409);
        expect((await register(srv.client(), 'x')).status).toBe(400);
        expect((await register(srv.client(), 'okname', 'short')).status).toBe(400);
    });

    it('answers the same for an unknown user and a wrong password', async () => {
        await register(srv.client());
        const unknown = await srv.client().post('/api/auth/login', { username: 'nobody', password: 'whatever pass' });
        const wrong = await srv.client().post('/api/auth/login', { username: 'general', password: 'whatever pass' });
        expect(unknown.status).toBe(401);
        expect(wrong.status).toBe(401);
        expect(unknown.body).toEqual(wrong.body);
    });

    it('rejects non-JSON posts and malformed JSON', async () => {
        const c = srv.client();
        expect(
            (await c.post('/api/auth/login', 'username=a&password=b', { 'Content-Type': 'application/x-www-form-urlencoded' })).status,
        ).toBe(415);
        expect((await c.post('/api/auth/login', '{bad json')).status).toBe(400);
    });
});

describe('anti-bot', () => {
    let srv;
    afterEach(() => srv?.close());

    it('rejects a filled honeypot', async () => {
        srv = await start();
        expect((await register(srv.client(), 'botname', 'long enough pass', { website: 'http://spam' })).status).toBe(400);
        await register(srv.client());
        expect(
            (await srv.client().post('/api/auth/login', { username: 'general', password: 'correct horse battery', website: 'x' })).status,
        ).toBe(401);
    });

    it('rejects wrong, missing, forged and reused challenges', async () => {
        srv = await start({ limits: { ...DEFAULTS.limits, register: { windowMs: 60_000, max: 50 } } });
        const c = srv.client();
        const challenge = (await c.get('/api/auth/challenge')).body;
        const body = (extra) => ({ username: 'player1', password: 'long enough pass', challenge, nonce: solve(challenge), ...extra });
        expect((await c.post('/api/auth/register', body({ challenge: undefined }))).status).toBe(400);
        expect((await c.post('/api/auth/register', body({ challenge: { ...challenge, bits: 1 } }))).status).toBe(400);
        expect((await c.post('/api/auth/register', body({ challenge: { ...challenge, salt: 'f'.repeat(32) } }))).status).toBe(400);
        // A nonce that does not solve it
        let bad = 0;
        while (leadingZeroBits(crypto.createHash('sha256').update(`${challenge.salt}:${bad}`).digest()) >= challenge.bits) bad++;
        expect((await c.post('/api/auth/register', body({ nonce: bad }))).status).toBe(400);
        // Valid once, then refused
        expect((await c.post('/api/auth/register', body())).status).toBe(201);
        expect((await srv.client().post('/api/auth/register', body({ username: 'player2' }))).status).toBe(400);
    });

    it('rejects challenges answered too fast or too late', async () => {
        const fast = createChallenges({ secret: 's', bits: 1, minAgeMs: 5000, maxAgeMs: 60_000 });
        const c1 = fast.issue();
        expect(fast.verify(c1, solve(c1))).toBe('too fast');
        const late = createChallenges({ secret: 's', bits: 1, minAgeMs: 0, maxAgeMs: 60_000 });
        const c2 = { ...late.issue() };
        c2.issued -= 120_000;
        // Re-sign is impossible without the secret: an edited date is a bad signature
        expect(late.verify(c2, solve(c2))).toBe('bad signature');
        fast.close();
        late.close();
    });

    it('locks an account after repeated failures', async () => {
        srv = await start({ lockout: { maxFailures: 3, windowMs: 60_000, lockMs: 60_000 } });
        await register(srv.client());
        const c = srv.client();
        for (let i = 0; i < 3; i++)
            expect((await c.post('/api/auth/login', { username: 'general', password: 'nope nope nope' })).status).toBe(401);
        const locked = await c.post('/api/auth/login', { username: 'general', password: 'correct horse battery' });
        expect(locked.status).toBe(429);
        expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    });

    it('rate-limits login attempts per IP', async () => {
        srv = await start({ limits: { ...DEFAULTS.limits, login: { windowMs: 60_000, max: 3 } } });
        const c = srv.client();
        const statuses = [];
        for (let i = 0; i < 5; i++)
            statuses.push((await c.post('/api/auth/login', { username: `user${i}`, password: 'whatever pass' })).status);
        expect(statuses).toEqual([401, 401, 401, 429, 429]);
    });
});

describe('registration rate limit', () => {
    it('stops a burst of sign-ups from one IP', async () => {
        const srv = await start({ limits: { ...DEFAULTS.limits, register: { windowMs: 60_000, max: 2 } } });
        const statuses = [];
        for (let i = 0; i < 3; i++) statuses.push((await register(srv.client(), `soldier${i}`)).status);
        expect(statuses).toEqual([201, 201, 429]);
        await srv.close();
    });
});
