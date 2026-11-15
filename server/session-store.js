/**
 * @file express-session store backed by the SQLite `sessions` table, so
 * logins survive a restart (the default MemoryStore does not, and leaks).
 */

import session from 'express-session';

const DAY_MS = 24 * 60 * 60 * 1000;

export class SqliteSessionStore extends session.Store {
    /**
     * @param {import('node:sqlite').DatabaseSync} db
     * @param {{ pruneEveryMs?: number }} [options]
     */
    constructor(db, { pruneEveryMs = 60 * 60 * 1000 } = {}) {
        super();
        this.q = {
            get: db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?'),
            set: db.prepare(
                'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires',
            ),
            touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
            destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
            prune: db.prepare('DELETE FROM sessions WHERE expires < ?'),
        };
        this.timer = setInterval(() => this.q.prune.run(Date.now()), pruneEveryMs);
        this.timer.unref?.();
    }

    static expiry(sess) {
        return sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DAY_MS;
    }

    get(sid, cb) {
        try {
            const row = this.q.get.get(sid);
            if (!row || row.expires < Date.now()) return cb(null, null);
            cb(null, JSON.parse(row.sess));
        } catch (err) {
            cb(err);
        }
    }

    set(sid, sess, cb) {
        try {
            this.q.set.run(sid, JSON.stringify(sess), SqliteSessionStore.expiry(sess));
            cb?.(null);
        } catch (err) {
            cb?.(err);
        }
    }

    touch(sid, sess, cb) {
        try {
            this.q.touch.run(SqliteSessionStore.expiry(sess), sid);
            cb?.(null);
        } catch (err) {
            cb?.(err);
        }
    }

    destroy(sid, cb) {
        try {
            this.q.destroy.run(sid);
            cb?.(null);
        } catch (err) {
            cb?.(err);
        }
    }

    close() {
        clearInterval(this.timer);
    }
}
