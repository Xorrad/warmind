/**
 * @file Entry point: reads the environment, opens the database, listens.
 *
 * Environment (see .env.example): PORT, DB_PATH, SESSION_SECRET,
 * NODE_ENV=production (secure cookies, HSTS, no test sessions),
 * TRUST_PROXY=1 (behind a reverse proxy, for client IPs and secure
 * cookies), TEST_SESSIONS=1 (allow test sessions in production),
 * BUILD_COMMIT (commit shown under the logo when git is not available).
 */

import crypto from 'node:crypto';
import { BUILD } from './build.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const production = process.env.NODE_ENV === 'production';
let secret = process.env.SESSION_SECRET;
if (!secret) {
    if (production) {
        console.error('SESSION_SECRET is required in production.');
        process.exit(1);
    }
    // Development: random each start (logins do not survive a restart)
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET not set: using a random one (sessions end on restart).');
}

if (production && process.env.TRUST_PROXY !== '1') {
    // Secure cookies are only sent over HTTPS: behind a proxy that does the
    // HTTPS (all hosting platforms), the app must trust it, or no login sticks
    console.warn('NODE_ENV=production without TRUST_PROXY=1: logins only work if this process serves HTTPS itself.');
}

const db = openDb(process.env.DB_PATH || 'data/warmind.db');
const app = createApp({
    db,
    secret,
    secureCookies: production,
    trustProxy: process.env.TRUST_PROXY === '1',
    // Dev tools (test sessions, Skip day): off in production unless TEST_SESSIONS=1
    testSessions: !production || process.env.TEST_SESSIONS === '1',
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
    console.log(`WarMind v${BUILD.version}${BUILD.commit ? ` (${BUILD.commit})` : ''} running on http://localhost:${port}`);
});

// Hosts stop the app with SIGTERM on every deploy: finish the requests in
// progress, then close the database cleanly (SQLite WAL checkpoint)
let stopping = false;
function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: shutting down`);
    server.close(() => {
        app.close();
        db.close();
        process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
        console.error('Shutdown timed out: forcing exit');
        process.exit(1);
    }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
