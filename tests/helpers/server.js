/**
 * Shared helpers for server tests: run the app on a free port with an
 * in-memory database, and talk to it like a browser (keeping the cookie).
 */

import crypto from 'node:crypto';
import { createApp } from '../../server/app.js';
import { openDb } from '../../server/db.js';
import { leadingZeroBits } from '../../server/antibot.js';

/** Start the app on a free port; returns a tiny client keeping its cookie. */
export async function start(overrides = {}) {
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
            put: (p, b, h) => request('PUT', p, b, h),
            get cookie() {
                return cookie;
            },
        };
    };
    return { db, app, client, port: server.address().port, close: () => new Promise((r) => (app.close(), server.close(r))) };
}

/** Solve a challenge like the browser does. */
export function solve(challenge) {
    for (let nonce = 0; ; nonce++) {
        const hash = crypto.createHash('sha256').update(`${challenge.salt}:${nonce}`).digest();
        if (leadingZeroBits(hash) >= challenge.bits) return nonce;
    }
}

export async function register(c, username = 'general', password = 'correct horse battery', extra = {}) {
    const challenge = (await c.get('/api/auth/challenge')).body;
    return c.post('/api/auth/register', { username, password, challenge, nonce: solve(challenge), website: '', ...extra });
}
