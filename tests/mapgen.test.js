import { describe, it, expect } from 'vitest';
import { generateMap } from '../engine/mapgen.js';
import { createRng } from '../engine/rng.js';
import { TERRAINS } from '../engine/config.js';

describe('rng', () => {
    it('is deterministic for a given seed', () => {
        const a = createRng('seed');
        const b = createRng('seed');
        for (let i = 0; i < 10; i++) expect(a.next()).toBe(b.next());
    });

    it('int() stays within inclusive bounds', () => {
        const r = createRng(1);
        for (let i = 0; i < 1000; i++) {
            const v = r.int(2, 5);
            expect(v).toBeGreaterThanOrEqual(2);
            expect(v).toBeLessThanOrEqual(5);
        }
    });
});

describe('generateMap', () => {
    const seeds = ['demo', 'alpha', 'warmind', 42];

    it('produces the same map for the same seed', () => {
        expect(generateMap({ seed: 'x' })).toEqual(generateMap({ seed: 'x' }));
    });

    it('produces different maps for different seeds', () => {
        expect(generateMap({ seed: 'x' })).not.toEqual(generateMap({ seed: 'y' }));
    });

    it.each(seeds)('has symmetric adjacency (seed %s)', (seed) => {
        const { provinces } = generateMap({ seed });
        for (const p of provinces) {
            expect(p.neighbours.length).toBeGreaterThan(0);
            for (const n of p.neighbours) expect(provinces[n].neighbours).toContain(p.id);
        }
    });

    it.each(seeds)('gives every province an owner and a valid terrain (seed %s)', (seed) => {
        const { provinces, factions } = generateMap({ seed });
        for (const p of provinces) {
            expect(p.owner).toBeGreaterThanOrEqual(0);
            expect(p.owner).toBeLessThan(factions.length);
            expect(TERRAINS).toHaveProperty(p.terrain);
        }
    });

    it.each(seeds)('gives each faction one connected territory around its capital (seed %s)', (seed) => {
        const { provinces, factions } = generateMap({ seed });
        for (const f of factions) {
            expect(provinces[f.capital].owner).toBe(f.id);
            expect(provinces[f.capital].isCapital).toBe(true);

            const owned = provinces.filter((p) => p.owner === f.id).map((p) => p.id);
            const seen = new Set([f.capital]);
            const queue = [f.capital];
            while (queue.length) {
                for (const n of provinces[queue.shift()].neighbours) {
                    if (provinces[n].owner === f.id && !seen.has(n)) {
                        seen.add(n);
                        queue.push(n);
                    }
                }
            }
            expect(seen.size).toBe(owned.length);
        }
    });

    it('marks exactly one player faction', () => {
        const { factions } = generateMap({ seed: 'demo' });
        expect(factions.filter((f) => f.isPlayer)).toHaveLength(1);
    });

    it('gives provinces unique names', () => {
        const { provinces } = generateMap({ seed: 'demo' });
        expect(new Set(provinces.map((p) => p.name)).size).toBe(provinces.length);
    });
});
