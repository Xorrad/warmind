import { describe, it, expect } from 'vitest';
import { openDb } from '../server/db.js';

describe('database', () => {
    it('commits a transaction, and rolls it back when it throws', () => {
        const db = openDb(':memory:');
        db.transaction(() => db.createUser('kept', 'hash'));
        expect(() =>
            db.transaction(() => {
                db.createUser('dropped', 'hash');
                throw new Error('boom');
            }),
        ).toThrow('boom');
        expect(db.findUser('kept')).toBeDefined();
        expect(db.findUser('dropped')).toBeUndefined();
        db.close();
    });

    it('nests transactions with savepoints', () => {
        const db = openDb(':memory:');
        db.transaction(() => {
            db.createUser('outer', 'hash');
            expect(() =>
                db.transaction(() => {
                    db.createUser('inner', 'hash');
                    throw new Error('inner fails');
                }),
            ).toThrow();
            // The outer transaction goes on and commits
        });
        expect(db.findUser('outer')).toBeDefined();
        expect(db.findUser('inner')).toBeUndefined();
        db.close();
    });

    it('reports a taken username as null and keeps ids numeric', () => {
        const db = openDb(':memory:');
        const id = db.createUser('Unique', 'hash');
        expect(typeof id).toBe('number');
        expect(db.createUser('unique', 'other')).toBeNull();
        db.close();
    });
});
