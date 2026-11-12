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
`;

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

    const q = {
        userByKey: db.prepare(
            'SELECT id, username, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE username_key = ?',
        ),
        userById: db.prepare('SELECT id, username, created_at AS createdAt FROM users WHERE id = ?'),
        insertUser: db.prepare('INSERT INTO users (username, username_key, password_hash) VALUES (?, ?, ?)'),
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
        close: () => db.close(),
    };
}
