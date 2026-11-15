/**
 * @file SQLite schema and queries.
 *
 * One file (DB_PATH), opened with better-sqlite3. The schema is created on
 * start; queries are prepared once.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL,
    username_key  TEXT    NOT NULL UNIQUE,  -- lowercase, for case-insensitive uniqueness
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT    PRIMARY KEY,
    sess    TEXT    NOT NULL,
    expires INTEGER NOT NULL                -- ms since epoch
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires);
-- One saved game per user: tasks, points ledger and campaign, as JSON.
-- version goes up by one on every save (optimistic concurrency).
CREATE TABLE IF NOT EXISTS saves (
    user_id    INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    data       TEXT    NOT NULL,
    version    INTEGER NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    news       TEXT    NOT NULL DEFAULT '[]'  -- settlement reports not yet shown
);
`;

/** Columns added after a table was first created: [table, column, definition]. */
const ADDED_COLUMNS = [['saves', 'news', "TEXT NOT NULL DEFAULT '[]'"]];

/**
 * Open (and create if needed) the database.
 * @param {string} file Path, or ':memory:'.
 */
export function openDb(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    for (const [table, column, definition] of ADDED_COLUMNS) {
        const exists = db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column);
        if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }

    const q = {
        userByKey: db.prepare(
            'SELECT id, username, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE username_key = ?',
        ),
        userById: db.prepare('SELECT id, username, created_at AS createdAt FROM users WHERE id = ?'),
        insertUser: db.prepare('INSERT INTO users (username, username_key, password_hash) VALUES (?, ?, ?)'),
        getSave: db.prepare('SELECT data, version, updated_at AS updatedAt, news FROM saves WHERE user_id = ?'),
        setNews: db.prepare('UPDATE saves SET news = ? WHERE user_id = ?'),
        insertSave: db.prepare('INSERT INTO saves (user_id, data, version) VALUES (?, ?, 1)'),
        updateSave: db.prepare(
            "UPDATE saves SET data = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND version = ?",
        ),
    };

    return {
        raw: db,
        /** @returns {{ id: number, username: string, passwordHash: string, createdAt: string }|undefined} */
        findUser: (username) => q.userByKey.get(username.toLowerCase()),
        /** @returns {{ id: number, username: string, createdAt: string }|undefined} */
        getUser: (id) => q.userById.get(id),
        /**
         * @returns {number|null} New user id, or null if the name is taken.
         */
        createUser(username, passwordHash) {
            try {
                return Number(q.insertUser.run(username, username.toLowerCase(), passwordHash).lastInsertRowid);
            } catch (err) {
                if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
                throw err;
            }
        },
        /** @returns {{ data: string, version: number, updatedAt: string, news: string }|undefined} */
        getSave: (userId) => q.getSave.get(userId),
        /** Replace the pending settlement reports (JSON list). */
        setNews: (userId, json) => q.setNews.run(json, userId),
        /** Run `fn` in one transaction (read, compute, write). */
        transaction: (fn) => db.transaction(fn)(),
        /**
         * Store a user's save if `baseVersion` is the current one (0 when
         * there is none yet).
         * @returns {{ ok: true, version: number, updatedAt: string } | { ok: false }} Not ok on a version conflict.
         */
        putSave: db.transaction((userId, json, baseVersion) => {
            const done = baseVersion === 0 ? safeInsert(userId, json) : q.updateSave.run(json, userId, baseVersion).changes === 1;
            if (!done) return { ok: false };
            const row = q.getSave.get(userId);
            return { ok: true, version: row.version, updatedAt: row.updatedAt };
        }),
        close: () => db.close(),
    };

    function safeInsert(userId, json) {
        try {
            q.insertSave.run(userId, json);
            return true;
        } catch (err) {
            // Another request created it first: a conflict
            if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
            throw err;
        }
    }
}
