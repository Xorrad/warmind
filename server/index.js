/**
 * @file Entry point: reads the environment, opens the database, listens.
 *
 * Environment (see .env.example): PORT, DB_PATH, SESSION_SECRET,
 * NODE_ENV=production (secure cookies), TRUST_PROXY=1 (behind a reverse
 * proxy, for client IPs and secure cookies).
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

const db = openDb(process.env.DB_PATH || 'data/warmind.db');
const app = createApp({
    db,
    secret,
    secureCookies: production,
    trustProxy: process.env.TRUST_PROXY === '1',
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
    console.log(`WarMind v${BUILD.version}${BUILD.commit ? ` (${BUILD.commit})` : ''} running on http://localhost:${port}`);
});
