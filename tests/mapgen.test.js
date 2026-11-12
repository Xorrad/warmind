import { describe, it, expect } from 'vitest';
import { generateMap } from '../engine/mapgen.js';
import { createRng } from '../engine/rng.js';
import { TERRAINS, MAP } from '../engine/config.js';
import { isPassable, canMove } from '../engine/actions.js';

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
        for (const p of provinces.filter((q) => TERRAINS[q.terrain].passable)) {
            expect(p.neighbours.length).toBeGreaterThan(0);
            for (const n of p.neighbours) expect(provinces[n].neighbours).toContain(p.id);
        }
    });

    it.each(seeds)('gives every passable province an owner and a valid terrain (seed %s)', (seed) => {
        const { provinces, factions } = generateMap({ seed });
        for (const p of provinces) {
            expect(TERRAINS).toHaveProperty(p.terrain);
            if (!TERRAINS[p.terrain].passable) continue;
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

describe('mountain ranges', () => {
    const seeds = ['demo', 'alpha', 'warmind', 42];
    const isRange = (p) => p.terrain === 'range';
    const isImpassable = (p) => !TERRAINS[p.terrain].passable;

    it.each(seeds)('generates the configured number of impassable, unowned ranges (seed %s)', (seed) => {
        const { provinces } = generateMap({ seed });
        const ranges = provinces.filter(isRange);
        expect(ranges).toHaveLength(MAP.ranges.count);
        for (const r of ranges) {
            expect(r.owner).toBe(-1);
            expect(r.isCapital).toBe(false);
            expect(r.neighbours).toEqual([]);
            expect(r.borders.length).toBeGreaterThanOrEqual(2);
            for (const b of r.borders) expect(isImpassable(provinces[b])).toBe(false);
        }
    });

    it.each(seeds)('are never a neighbour of any province (seed %s)', (seed) => {
        const { provinces } = generateMap({ seed });
        for (const p of provinces) for (const n of p.neighbours) expect(isImpassable(provinces[n])).toBe(false);
    });

    it.each(seeds)('keep every passable province reachable (seed %s)', (seed) => {
        const { provinces } = generateMap({ seed });
        const passable = provinces.filter((p) => !isImpassable(p));
        const seen = new Set([passable[0].id]);
        const queue = [passable[0].id];
        while (queue.length) {
            for (const n of provinces[queue.shift()].neighbours) {
                if (!seen.has(n)) {
                    seen.add(n);
                    queue.push(n);
                }
            }
        }
        expect(seen.size).toBe(passable.length);
    });

    it('cut adjacency between the provinces they separate', () => {
        const flat = generateMap({ seed: 'demo', ranges: { ...MAP.ranges, count: 0 } });
        const carved = generateMap({ seed: 'demo' });
        const edges = (m) => m.provinces.reduce((s, p) => s + p.neighbours.length, 0);
        expect(edges(carved)).toBeLessThan(edges(flat));
    });

    it.each([0.2, 0.5, 0.8, 1.5])('have outlines that never cross themselves (borderJitter %s)', (borderJitter) => {
        const orient = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
        const crosses = (a, b, c, d) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
        for (const seed of seeds) {
            for (const r of generateMap({ seed, borderJitter }).provinces.filter(isRange)) {
                const poly = r.polygon;
                const n = poly.length;
                expect(n).toBeGreaterThanOrEqual(3);
                for (let i = 0; i < n; i++) {
                    for (let k = i + 2; k < n; k++) {
                        if (i === 0 && k === n - 1) continue;
                        expect(crosses(poly[i], poly[(i + 1) % n], poly[k], poly[(k + 1) % n]), `${r.name} (seed ${seed})`).toBe(false);
                    }
                }
            }
        }
    });

    it('can be disabled', () => {
        const { provinces } = generateMap({ seed: 'demo', ranges: { ...MAP.ranges, count: 0 } });
        expect(provinces.filter(isRange)).toHaveLength(0);
    });
});

describe('movement rules', () => {
    const map = generateMap({ seed: 'demo' });
    const range = map.provinces.find((p) => p.terrain === 'range');
    const land = map.provinces.find((p) => p.terrain !== 'range');

    it('forbids entering or stationing in a mountain range', () => {
        expect(isPassable(range)).toBe(false);
        expect(isPassable(land)).toBe(true);
        for (const b of range.borders) expect(canMove(map, b, range.id)).toBe(false);
    });

    it('allows moving between neighbours only', () => {
        expect(canMove(map, land.id, land.neighbours[0])).toBe(true);
        const far = map.provinces.find((p) => p.id !== land.id && isPassable(p) && !land.neighbours.includes(p.id));
        expect(canMove(map, land.id, far.id)).toBe(false);
    });
});

describe('borders', () => {
    const orient = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    const crosses = (a, b, c, d) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;

    it.each([0.5, 1, 2])('never cross each other, even with borderJitter %s', (borderJitter) => {
        const { provinces } = generateMap({ seed: 'demo', provinceCount: 80, borderJitter });
        const segments = new Map();
        for (const p of provinces.filter((q) => q.terrain !== 'range')) {
            p.polygon.forEach((a, i) => {
                const b = p.polygon[(i + 1) % p.polygon.length];
                segments.set([String(a), String(b)].sort().join('|'), [a, b]);
            });
        }
        const list = [...segments.values()];
        let crossings = 0;
        for (let i = 0; i < list.length; i++) {
            for (let k = i + 1; k < list.length; k++) if (crosses(...list[i], ...list[k])) crossings++;
        }
        expect(crossings).toBe(0);
    });
});

describe('seas', () => {
    const seeds = ['demo', 'alpha', 'warmind', 42];
    const isSea = (p) => p.terrain === 'sea';
    const shoelace = (poly) =>
        Math.abs(
            poly.reduce((s, [x0, y0], i) => {
                const [x1, y1] = poly[(i + 1) % poly.length];
                return s + x0 * y1 - x1 * y0;
            }, 0),
        ) / 2;

    it.each(seeds)('are impassable, unowned and only border land (seed %s)', (seed) => {
        const { provinces } = generateMap({ seed });
        const seas = provinces.filter(isSea);
        expect(seas.length).toBeGreaterThan(0);
        for (const s of seas) {
            expect(TERRAINS.sea.passable).toBe(false);
            expect(s.owner).toBe(-1);
            expect(s.neighbours).toEqual([]);
            expect(s.borders.length).toBeGreaterThan(0);
            for (const b of s.borders) expect(TERRAINS[provinces[b].terrain].passable).toBe(true);
        }
    });

    it.each(seeds)('are larger than land provinces on average (seed %s)', (seed) => {
        const { provinces } = generateMap({ seed });
        const mean = (list) => list.reduce((s, p) => s + shoelace(p.polygon), 0) / list.length;
        const land = provinces.filter((p) => p.owner >= 0);
        expect(mean(provinces.filter(isSea))).toBeGreaterThan(1.5 * mean(land));
    });

    it.each(seeds)('come before ranges and after land in the numbering (seed %s)', (seed) => {
        const { provinces } = generateMap({ seed });
        const order = provinces.map((p) => (p.owner >= 0 ? 0 : isSea(p) ? 1 : 2));
        expect(order).toEqual([...order].sort());
        provinces.forEach((p, i) => expect(p.id).toBe(i));
    });

    it('can be disabled', () => {
        const { provinces } = generateMap({ seed: 'demo', seas: { ...MAP.seas, share: 0 } });
        expect(provinces.filter(isSea)).toHaveLength(0);
    });
});
