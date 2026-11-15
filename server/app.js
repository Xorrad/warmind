/**
 * @file Express app: static client, API routes. Built by createApp() so
 * tests can run it in memory; index.js reads the environment and listens.
 */

import express from 'express';
import session from 'express-session';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BUILD } from './build.js';
import { createAuthRouter } from './auth.js';
import { createSaveRouter, MAX_SAVE_BYTES } from './routes/campaign.js';
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
    /** Test sessions (?session=..., Skip day): dev tools, off in production unless asked for. */
    testSessions: true,
};

/**
 * Page URLs without the file extension: client/login.html is served at
 * /login/. The old forms (/login.html, /login) redirect there for good,
 * keeping their query string; /index.html redirects to /.
 * @param {string} dir Folder of the pages.
 */
export function cleanPageUrls(dir) {
    const pages = new Set(
        fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.html') && f !== 'index.html')
            .map((f) => f.slice(0, -'.html'.length)),
    );
    return (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const q = req.originalUrl.indexOf('?');
        const query = q === -1 ? '' : req.originalUrl.slice(q);
        if (req.path === '/index.html') return res.redirect(301, `/${query}`);
        const match = /^\/([\w-]+)(\.html|\/)?$/.exec(req.path);
        if (!match || !pages.has(match[1])) return next();
        if (match[2] === '/') return res.sendFile(path.join(dir, `${match[1]}.html`));
        return res.redirect(301, `/${match[1]}/${query}`);
    };
}

/**
 * Content-Security-Policy: everything from this origin only. The one inline
 * script is index.html's import map, allowed by its hash; inline style
 * attributes (colour swatches, bars) need 'unsafe-inline' for styles.
 */
export function contentSecurityPolicy() {
    const html = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
    const hashes = [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)].map(
        (m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`,
    );
    return [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(' ')}`.trim(),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join('; ');
}

/**
 * @param {{ db: ReturnType<typeof import('./db.js').openDb>, secret: string } & Partial<typeof DEFAULTS>} options
 */
export function createApp(options) {
    const o = { ...DEFAULTS, ...options };
    const app = express();
    app.disable('x-powered-by');
    if (o.trustProxy) app.set('trust proxy', 1);

    // Hardening headers
    const csp = contentSecurityPolicy();
    app.use((req, res, next) => {
        res.set({
            'Content-Security-Policy': csp,
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
            'X-Frame-Options': 'DENY',
            'Cross-Origin-Opener-Policy': 'same-origin',
        });
        // HTTPS only from now on (production, where cookies are secure too)
        if (o.secureCookies) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
        next();
    });

    // Front-end files, with clean page URLs
    app.use(cleanPageUrls(path.join(root, 'client')));
    app.use(express.static(path.join(root, 'client'), { index: 'index.html' }));
    // The game engine is shared: the browser imports it directly
    app.use('/engine', express.static(path.join(root, 'engine')));
    // Browser-side dependencies (mapped in index.html's import map)
    app.use('/vendor/d3-delaunay', express.static(path.join(root, 'node_modules/d3-delaunay/dist')));

    // Build version shown next to the logo
    // API answers are never cached: hosts often put a caching proxy in front
    // (stale versions, or worse, someone else's data)
    app.use('/api', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    app.get('/api/build', (req, res) => res.json({ ...BUILD, testSessions: o.testSessions }));

    // For the host's health checks: the process answers and the database too
    app.get('/api/health', (req, res) => {
        try {
            o.db.raw.prepare('SELECT 1').get();
            res.set('Cache-Control', 'no-store').json({ ok: true, version: BUILD.version, commit: BUILD.commit });
        } catch {
            res.status(503).json({ ok: false });
        }
    });

    // API: JSON bodies only. Browsers cannot send JSON across sites without
    // a CORS preflight, which this server never allows: no CSRF by form post.
    // Saved games are larger than anything else the API receives
    app.use('/api/save', express.json({ limit: MAX_SAVE_BYTES + 64 * 1024 }));
    app.use('/api', express.json({ limit: '20kb' }));
    app.use('/api', (req, res, next) => {
        const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method);
        if (hasBody && !req.is('application/json')) return res.status(415).json({ error: 'JSON expected.' });
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
    app.use('/api/save', createSaveRouter(o.db, { now: o.now }));

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
