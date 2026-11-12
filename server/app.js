/**
 * @file Express app: static client, API routes. Built by createApp() so
 * tests can run it in memory; index.js reads the environment and listens.
 */

import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD } from './build.js';
import { createAuthRouter } from './auth.js';
import { SqliteSessionStore } from './session-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Default settings; tests override some (cheaper hashing, easier challenges). */
export const DEFAULTS = {
    cookieName: 'warmind.sid',
    sessionDays: 30,
    secureCookies: false,
    trustProxy: false,
    bcryptRounds: 12,
    pow: { bits: 18, minAgeMs: 2000, maxAgeMs: 10 * 60 * 1000 },
    limits: {
        login: { windowMs: 15 * 60 * 1000, max: 20 },
        register: { windowMs: 60 * 60 * 1000, max: 5 },
        challenge: { windowMs: 15 * 60 * 1000, max: 60 },
    },
    lockout: { maxFailures: 5, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 },
};

/**
 * @param {{ db: ReturnType<typeof import('./db.js').openDb>, secret: string } & Partial<typeof DEFAULTS>} options
 */
export function createApp(options) {
    const o = { ...DEFAULTS, ...options };
    const app = express();
    app.disable('x-powered-by');
    if (o.trustProxy) app.set('trust proxy', 1);

    // Basic hardening headers
    app.use((req, res, next) => {
        res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
        next();
    });

    // Front-end files
    app.use(express.static(path.join(root, 'client')));
    // The game engine is shared: the browser imports it directly
    app.use('/engine', express.static(path.join(root, 'engine')));
    // Browser-side dependencies (mapped in index.html's import map)
    app.use('/vendor/d3-delaunay', express.static(path.join(root, 'node_modules/d3-delaunay/dist')));

    // Build version shown next to the logo
    app.get('/api/build', (req, res) => res.json(BUILD));

    // API: JSON bodies only. Browsers cannot send JSON across sites without
    // a CORS preflight, which this server never allows: no CSRF by form post.
    app.use('/api', express.json({ limit: '20kb' }));
    app.use('/api', (req, res, next) => {
        if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON expected.' });
        next();
    });

    const store = new SqliteSessionStore(o.db.raw);
    app.use(
        '/api',
        session({
            name: o.cookieName,
            secret: o.secret,
            store,
            resave: false,
            saveUninitialized: false,
            rolling: true,
            cookie: { httpOnly: true, sameSite: 'lax', secure: o.secureCookies, maxAge: o.sessionDays * DAY_MS },
        }),
    );

    const auth = createAuthRouter(o.db, o);
    app.use('/api/auth', auth);

    app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON.' });
        if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
    });

    app.close = () => {
        auth.close();
        store.close();
    };
    return app;
}
