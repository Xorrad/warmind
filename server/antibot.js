/**
 * @file Anti-bot measures, all self-hosted (no third-party captcha):
 *
 *  - rate limits per client IP (fixed windows, in memory);
 *  - lockout of an account after repeated failed logins;
 *  - honeypot: a form field hidden from people, that bots fill in;
 *  - signed challenges for registration: the server hands out a random
 *    salt signed with HMAC; the browser must find a nonce such that
 *    SHA-256(salt:nonce) starts with `bits` zero bits (proof of work, about
 *    a second in a browser), the challenge must be at least `minAgeMs` old
 *    (scripted instant submissions fail) and at most `maxAgeMs`, and it can
 *    be used once only.
 */

import crypto from 'node:crypto';

/**
 * Fixed-window rate limiter.
 * @param {{ windowMs: number, max: number }} options
 */
export function createRateLimiter({ windowMs, max }) {
    const hits = new Map();
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
    }, windowMs);
    timer.unref?.();
    return {
        /** Count a hit; returns the seconds to wait when over the limit, else 0. */
        hit(key) {
            const now = Date.now();
            let entry = hits.get(key);
            if (!entry || entry.reset <= now) {
                entry = { count: 0, reset: now + windowMs };
                hits.set(key, entry);
            }
            entry.count++;
            return entry.count > max ? Math.ceil((entry.reset - now) / 1000) : 0;
        },
        reset: (key) => hits.delete(key),
        close: () => clearInterval(timer),
    };
}

/**
 * Express middleware limiting a route per client IP.
 * @param {ReturnType<typeof createRateLimiter>} limiter
 * @param {string} name
 */
export function rateLimit(limiter, name) {
    return (req, res, next) => {
        const wait = limiter.hit(`${name}:${req.ip}`);
        if (!wait) return next();
        res.set('Retry-After', String(wait));
        res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });
    };
}

/**
 * Failed-login tracking per username: after `maxFailures` within
 * `windowMs`, the account is locked for `lockMs`.
 */
export function createLockout({ maxFailures, windowMs, lockMs }) {
    const entries = new Map();
    return {
        /** Seconds left on the lock, or 0. */
        lockedFor(key) {
            const e = entries.get(key);
            if (!e?.lockedUntil) return 0;
            const left = e.lockedUntil - Date.now();
            if (left <= 0) {
                entries.delete(key);
                return 0;
            }
            return Math.ceil(left / 1000);
        },
        fail(key) {
            const now = Date.now();
            const e = entries.get(key);
            const entry = !e || now - e.first > windowMs ? { first: now, count: 0 } : e;
            entry.count++;
            if (entry.count >= maxFailures) entry.lockedUntil = now + lockMs;
            entries.set(key, entry);
        },
        succeed: (key) => entries.delete(key),
    };
}

/** Whether the honeypot field was filled in (a bot). */
export function honeypotTripped(body) {
    return typeof body?.website === 'string' && body.website.trim() !== '';
}

/** Number of leading zero bits of a buffer. */
export function leadingZeroBits(buf) {
    let bits = 0;
    for (const byte of buf) {
        if (byte === 0) {
            bits += 8;
            continue;
        }
        return bits + Math.clz32(byte) - 24;
    }
    return bits;
}

/**
 * Signed, single-use proof-of-work challenges.
 * @param {{ secret: string, bits: number, minAgeMs: number, maxAgeMs: number }} options
 */
export function createChallenges({ secret, bits, minAgeMs, maxAgeMs }) {
    const used = new Map(); // id -> expiry
    const sign = (c) => crypto.createHmac('sha256', secret).update(`${c.id}|${c.salt}|${c.bits}|${c.issued}`).digest('hex');
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [id, expiry] of used) if (expiry <= now) used.delete(id);
    }, maxAgeMs);
    timer.unref?.();

    return {
        issue() {
            const c = {
                id: crypto.randomBytes(16).toString('hex'),
                salt: crypto.randomBytes(16).toString('hex'),
                bits,
                issued: Date.now(),
            };
            return { ...c, sig: sign(c) };
        },
        /**
         * @param {any} challenge As issued.
         * @param {any} nonce The solution.
         * @returns {string|null} Why it is refused, or null when valid.
         */
        verify(challenge, nonce) {
            if (!challenge || typeof challenge !== 'object') return 'missing challenge';
            const { id, salt, issued, sig } = challenge;
            const c = { id: String(id), salt: String(salt), bits: Number(challenge.bits), issued: Number(issued) };
            const expected = sign(c);
            if (
                typeof sig !== 'string' ||
                sig.length !== expected.length ||
                !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
            )
                return 'bad signature';
            if (c.bits < bits) return 'too easy';
            const age = Date.now() - c.issued;
            if (age < minAgeMs) return 'too fast';
            if (age > maxAgeMs) return 'expired';
            if (used.has(c.id)) return 'already used';
            if (!Number.isSafeInteger(nonce) || nonce < 0) return 'bad nonce';
            const hash = crypto.createHash('sha256').update(`${c.salt}:${nonce}`).digest();
            if (leadingZeroBits(hash) < c.bits) return 'wrong solution';
            used.set(c.id, c.issued + maxAgeMs);
            return null;
        },
        close: () => clearInterval(timer),
    };
}
