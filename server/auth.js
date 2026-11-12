/**
 * @file Register, login, logout, auth middleware.
 *
 * Routes (JSON in, JSON out), mounted on /api/auth:
 *   GET  /challenge  anti-bot challenge to solve before registering
 *   POST /register   { username, password, challenge, nonce, website }
 *   POST /login      { username, password, website }
 *   POST /logout
 *   GET  /me         the logged-in user, or 401
 *
 * `website` is the honeypot field: real forms leave it empty.
 */

import express from 'express';
import bcrypt from 'bcrypt';
import { createRateLimiter, rateLimit, createLockout, honeypotTripped, createChallenges } from './antibot.js';

export const USERNAME = /^[A-Za-z0-9_-]{3,24}$/;
export const PASSWORD_MIN = 8;
/** bcrypt only uses the first 72 bytes of a password. */
export const PASSWORD_MAX_BYTES = 72;

/** Check the registration fields; returns an error message or null. */
export function validateCredentials(username, password) {
    if (typeof username !== 'string' || !USERNAME.test(username)) return 'Usernames are 3 to 24 letters, digits, "_" or "-".';
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `Passwords need at least ${PASSWORD_MIN} characters.`;
    if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) return `Passwords are limited to ${PASSWORD_MAX_BYTES} bytes.`;
    if (password.toLowerCase().includes(username.toLowerCase())) return 'The password must not contain the username.';
    return null;
}

/** Log a user in on this session, with a new session id (no fixation). */
function startSession(req, user) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
            if (err) return reject(err);
            req.session.userId = user.id;
            req.session.save((err2) => (err2 ? reject(err2) : resolve()));
        });
    });
}

const publicUser = (u) => ({ id: u.id, username: u.username, createdAt: u.createdAt });

/** Middleware for routes that need a logged-in user (sets req.user). */
export function requireAuth(db) {
    return (req, res, next) => {
        const user = req.session?.userId ? db.getUser(req.session.userId) : null;
        if (!user) return res.status(401).json({ error: 'Not logged in.' });
        req.user = user;
        next();
    };
}

/**
 * @param {ReturnType<typeof import('./db.js').openDb>} db
 * @param {{
 *   secret: string, bcryptRounds: number, cookieName: string,
 *   pow: { bits: number, minAgeMs: number, maxAgeMs: number },
 *   limits: { login: { windowMs: number, max: number }, register: { windowMs: number, max: number }, challenge: { windowMs: number, max: number } },
 *   lockout: { maxFailures: number, windowMs: number, lockMs: number },
 * }} options
 */
export function createAuthRouter(db, options) {
    const router = express.Router();
    const challenges = createChallenges({ secret: options.secret, ...options.pow });
    const limiters = {
        login: createRateLimiter(options.limits.login),
        register: createRateLimiter(options.limits.register),
        challenge: createRateLimiter(options.limits.challenge),
    };
    const lockout = createLockout(options.lockout);
    // Compared against for unknown usernames, so both cases take as long
    const dummyHash = bcrypt.hashSync('not-a-real-password', options.bcryptRounds);
    const botError = (res) => res.status(400).json({ error: 'Verification failed. Reload the page and try again.' });

    router.get('/challenge', rateLimit(limiters.challenge, 'challenge'), (req, res) => {
        res.set('Cache-Control', 'no-store').json(challenges.issue());
    });

    router.post('/register', rateLimit(limiters.register, 'register'), async (req, res, next) => {
        try {
            const { username, password, challenge, nonce } = req.body ?? {};
            if (honeypotTripped(req.body)) return botError(res);
            const refused = challenges.verify(challenge, nonce);
            if (refused) return botError(res);
            const invalid = validateCredentials(username, password);
            if (invalid) return res.status(400).json({ error: invalid });
            const hash = await bcrypt.hash(password, options.bcryptRounds);
            const id = db.createUser(username, hash);
            if (id === null) return res.status(409).json({ error: 'This username is taken.' });
            const user = db.getUser(id);
            await startSession(req, user);
            res.status(201).json({ user: publicUser(user) });
        } catch (err) {
            next(err);
        }
    });

    router.post('/login', rateLimit(limiters.login, 'login'), async (req, res, next) => {
        try {
            const { username, password } = req.body ?? {};
            const failed = () => res.status(401).json({ error: 'Wrong username or password.' });
            if (honeypotTripped(req.body)) return failed();
            if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || Buffer.byteLength(password) > 256) return failed();
            const key = username.toLowerCase();
            const locked = lockout.lockedFor(key);
            if (locked) {
                res.set('Retry-After', String(locked));
                return res.status(429).json({ error: `Too many failed attempts on this account. Try again in ${Math.ceil(locked / 60)} min.` });
            }
            const user = db.findUser(username);
            const ok = await bcrypt.compare(password, user?.passwordHash ?? dummyHash);
            if (!user || !ok) {
                lockout.fail(key);
                return failed();
            }
            lockout.succeed(key);
            await startSession(req, user);
            res.json({ user: publicUser(user) });
        } catch (err) {
            next(err);
        }
    });

    router.post('/logout', (req, res, next) => {
        req.session.destroy((err) => {
            if (err) return next(err);
            res.clearCookie(options.cookieName).status(204).end();
        });
    });

    router.get('/me', requireAuth(db), (req, res) => {
        res.set('Cache-Control', 'no-store').json({ user: publicUser(req.user) });
    });

    router.close = () => {
        challenges.close();
        Object.values(limiters).forEach((l) => l.close());
    };
    return router;
}
