/**
 * @file Voronoi province generation, terrain, adjacency, factions.
 *
 * Pipeline:
 *  1. scatter random points and relax them (Lloyd) for even province sizes;
 *  2. build the Voronoi diagram: one cell = one province, shared edge = neighbours;
 *  3. make borders jagged (deterministic per edge, so both sides match);
 *  4. assign terrain from smooth pseudo-noise;
 *  5. carve impassable mountain ranges along chains of borders;
 *  6. place faction capitals far apart and grow territories round-robin;
 *  7. append the ranges as extra (unowned, impassable) provinces.
 */

import { Delaunay } from 'd3-delaunay';
import { createRng, hashString } from './rng.js';
import { MAP, FACTIONS, NAME_PARTS } from './config.js';

/**
 * @typedef {[number, number]} Point
 *
 * @typedef {object} Province
 * @property {number} id
 * @property {string} name
 * @property {string} terrain Key of TERRAINS.
 * @property {number} owner Faction id, -1 for impassable provinces.
 * @property {boolean} isCapital
 * @property {number[]} neighbours Ids of provinces reachable in one move
 *   (always empty for impassable provinces).
 * @property {number[]} [borders] Impassable provinces only: ids of the
 *   provinces they touch.
 * @property {Point} center Centroid, used for labels and units.
 * @property {Point[]} polygon Outline (not closed: last point != first).
 *
 * @typedef {object} Faction
 * @property {number} id
 * @property {string} name
 * @property {string} color
 * @property {boolean} isPlayer
 * @property {number} capital Province id.
 *
 * @typedef {object} GameMap
 * @property {string} seed
 * @property {number} width
 * @property {number} height
 * @property {Province[]} provinces
 * @property {Faction[]} factions
 */

/**
 * Generate a complete map. Same options => same map.
 * @param {Partial<typeof MAP> & {seed?: string|number}} [options]
 * @returns {GameMap}
 */
export function generateMap(options = {}) {
    const o = { ...MAP, ...options };
    const seed = String(o.seed ?? 'warmind');
    const rng = createRng(seed);
    const bounds = [0, 0, o.width, o.height];

    // 1. Points + Lloyd relaxation
    const points = new Float64Array(o.provinceCount * 2);
    for (let i = 0; i < o.provinceCount; i++) {
        points[2 * i] = rng.range(0, o.width);
        points[2 * i + 1] = rng.range(0, o.height);
    }
    for (let k = 0; k < o.relaxIterations; k++) {
        const v = new Delaunay(points).voronoi(bounds);
        for (let i = 0; i < o.provinceCount; i++) {
            const c = centroid(openRing(v.cellPolygon(i)));
            points[2 * i] = c[0];
            points[2 * i + 1] = c[1];
        }
    }

    // 2. Voronoi cells and adjacency
    const voronoi = new Delaunay(points).voronoi(bounds);
    const provinces = [];
    const cells = [];
    for (let i = 0; i < o.provinceCount; i++) {
        const raw = openRing(voronoi.cellPolygon(i));
        cells.push(raw);
        provinces.push({
            id: i,
            name: '',
            terrain: 'plains',
            owner: -1,
            isCapital: false,
            neighbours: [...voronoi.neighbors(i)],
            center: roundPoint(centroid(raw)),
            polygon: roundPolygon(jaggedPolygon(raw, o)),
        });
    }

    // 3. Names
    const used = new Set();
    for (const p of provinces) p.name = uniqueName(rng, used);

    // 4. Terrain: rank provinces by noise so proportions are stable across seeds
    const elevation = makeNoise(rng, o.width, o.height);
    const moisture = makeNoise(rng, o.width, o.height);
    const byElevation = [...provinces].sort((a, b) => elevation(...b.center) - elevation(...a.center));
    const n = provinces.length;
    const nMountains = Math.round(n * o.terrainShare.mountains);
    const nHills = Math.round(n * o.terrainShare.hills);
    byElevation.slice(0, nMountains).forEach((p) => (p.terrain = 'mountains'));
    byElevation.slice(nMountains, nMountains + nHills).forEach((p) => (p.terrain = 'hills'));
    const lowlands = byElevation.slice(nMountains + nHills).sort((a, b) => moisture(...b.center) - moisture(...a.center));
    lowlands.slice(0, Math.round(n * o.terrainShare.forest)).forEach((p) => (p.terrain = 'forest'));

    // 5. Mountain ranges (before factions, so territories grow around them)
    const ranges = carveRanges(rng, provinces, cells, elevation, o);

    // 6. Factions
    const factionCount = Math.min(o.factionCount, FACTIONS.length, o.provinceCount);
    const capitals = farthestPoints(rng, provinces, factionCount, o.width, o.height);
    const factions = capitals.map((capital, id) => ({
        id,
        name: FACTIONS[id].name,
        color: FACTIONS[id].color,
        isPlayer: id === 0,
        capital,
    }));
    growTerritories(rng, provinces, capitals);
    for (const c of capitals) {
        provinces[c].isCapital = true;
        provinces[c].terrain = 'city';
    }

    // 7. Ranges become provinces of their own, after the regular ones
    for (const r of ranges) {
        provinces.push({
            id: provinces.length,
            name: `${uniqueName(rng, used)} Range`,
            terrain: 'range',
            owner: -1,
            isCapital: false,
            neighbours: [],
            borders: r.borders,
            center: roundPoint(r.spine[Math.floor(r.spine.length / 2)]),
            polygon: roundPolygon(ribbon(rng, smooth(r.spine, 2), o.ranges.width)),
        });
    }

    return { seed, width: o.width, height: o.height, provinces, factions };
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** d3 returns closed rings (last point == first); drop the duplicate. */
function openRing(ring) {
    return ring.slice(0, -1);
}

/**
 * Area-weighted centroid of a polygon.
 * @param {Point[]} poly
 * @returns {Point}
 */
export function centroid(poly) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i];
        const [x1, y1] = poly[(i + 1) % poly.length];
        const f = x0 * y1 - x1 * y0;
        a += f;
        cx += (x0 + x1) * f;
        cy += (y0 + y1) * f;
    }
    if (a === 0) return poly[0];
    return [cx / (3 * a), cy / (3 * a)];
}

const round1 = (n) => Math.round(n * 10) / 10;
const roundPoint = ([x, y]) => [round1(x), round1(y)];
const roundPolygon = (poly) => poly.map(roundPoint);

/**
 * Replace each straight inner edge by a jagged line. Edges on the map
 * border stay straight.
 */
function jaggedPolygon(poly, o) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        out.push(a);
        if (!isOnBorder(a, b, o)) out.push(...jaggedEdge(a, b, o));
    }
    return out;
}

function isOnBorder(a, b, o) {
    const eps = 1e-6;
    const same = (v, w, t) => Math.abs(v - t) < eps && Math.abs(w - t) < eps;
    return same(a[0], b[0], 0) || same(a[0], b[0], o.width) || same(a[1], b[1], 0) || same(a[1], b[1], o.height);
}

/**
 * Intermediate points of a jagged edge between a and b (endpoints excluded).
 * The randomness is seeded by the edge itself, so the two provinces that
 * share it generate exactly the same line.
 */
function jaggedEdge(a, b, o) {
    const key = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
    const ka = key(a);
    const kb = key(b);
    const reversed = ka > kb;
    const [p, q] = reversed ? [b, a] : [a, b];
    const rng = createRng(hashString(reversed ? `${kb}|${ka}` : `${ka}|${kb}`));

    let line = [p, q];
    let amp = o.borderJitter;
    for (let d = 0; d < o.borderDepth; d++) {
        const next = [line[0]];
        for (let i = 0; i < line.length - 1; i++) {
            const [x0, y0] = line[i];
            const [x1, y1] = line[i + 1];
            const dx = x1 - x0;
            const dy = y1 - y0;
            const offset = (rng.next() - 0.5) * 2 * amp; // fraction of segment length
            const mx = (x0 + x1) / 2 - dy * offset;
            const my = (y0 + y1) / 2 + dx * offset;
            next.push([clamp(mx, 0, o.width), clamp(my, 0, o.height)], line[i + 1]);
        }
        line = next;
        amp *= 0.6;
    }
    const inner = line.slice(1, -1);
    return reversed ? inner.reverse() : inner;
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/* ------------------------------------------------------------------ */
/* Mountain ranges                                                     */
/* ------------------------------------------------------------------ */

const vertexKey = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;

/**
 * Lay impassable ranges along winding chains of Voronoi edges. Each edge of
 * a chain separates two provinces, whose adjacency is removed. A chain is
 * rejected if it would split the map in two, so every province stays
 * reachable. Ranges never touch each other or the map edge.
 * @returns {{ spine: Point[], borders: number[] }[]}
 */
function carveRanges(rng, provinces, cells, elevation, o) {
    const { count, minEdges, maxEdges } = o.ranges;
    if (!count) return [];
    const margin = 0.04 * Math.min(o.width, o.height);
    const inside = ([x, y]) => x > margin && y > margin && x < o.width - margin && y < o.height - margin;

    // Graph of Voronoi vertices linked by the interior edges they share
    const edges = new Map();
    cells.forEach((poly, id) => {
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            const [ka, kb] = [vertexKey(a), vertexKey(b)];
            const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            if (!edges.has(k)) edges.set(k, { a, b, ka, kb, cells: [] });
            edges.get(k).cells.push(id);
        }
    });
    const vertices = new Map();
    for (const e of edges.values()) {
        if (e.cells.length !== 2 || !inside(e.a) || !inside(e.b)) continue;
        for (const [from, fk, to, tk] of [[e.a, e.ka, e.b, e.kb], [e.b, e.kb, e.a, e.ka]]) {
            if (!vertices.has(fk)) vertices.set(fk, { point: from, links: [] });
            vertices.get(fk).links.push({ to: tk, point: to, cells: e.cells });
        }
    }

    // Ranges start on high ground, so they line up with the mountain terrain
    const starts = [...vertices.keys()]
        .sort((a, b) => elevation(...vertices.get(b).point) - elevation(...vertices.get(a).point))
        .slice(0, Math.ceil(vertices.size / 3));

    const blocked = new Set();
    const ranges = [];
    for (let attempt = 0; ranges.length < count && attempt < count * 30; attempt++) {
        const start = rng.pick(starts);
        if (blocked.has(start)) continue;

        // Random walk with momentum: the heading drifts a little at each
        // step, which gives the snake-like shape
        const target = rng.int(minEdges, maxEdges);
        let heading = rng.range(0, Math.PI * 2);
        const path = [start];
        const steps = [];
        while (steps.length < target) {
            const here = vertices.get(path.at(-1));
            let best = null;
            let bestScore = -Infinity;
            for (const link of here.links) {
                if (path.includes(link.to) || blocked.has(link.to)) continue;
                const dir = Math.atan2(link.point[1] - here.point[1], link.point[0] - here.point[0]);
                const align = Math.cos(dir - heading);
                if (align < 0) continue; // no sharp turn back
                const score = align + rng.range(0, 0.6);
                if (score > bestScore) {
                    bestScore = score;
                    best = { link, dir };
                }
            }
            if (!best) break;
            path.push(best.link.to);
            steps.push(best.link);
            heading = best.dir + rng.range(-0.6, 0.6);
        }
        if (steps.length < minEdges) continue;

        // Cut adjacency along the chain, undo if the map is no longer connected
        for (const { cells: [a, b] } of steps) unlink(provinces, a, b);
        if (!isConnected(provinces)) {
            for (const { cells: [a, b] } of steps) link(provinces, a, b);
            continue;
        }

        for (const k of path) {
            blocked.add(k);
            for (const l of vertices.get(k).links) blocked.add(l.to);
        }
        const spine = [vertices.get(start).point];
        let prev = spine[0];
        for (const step of steps) {
            spine.push(...jaggedEdge(prev, step.point, o), step.point);
            prev = step.point;
        }
        const borders = [...new Set(steps.flatMap((s) => s.cells))].sort((x, y) => x - y);
        ranges.push({ spine, borders });
    }
    return ranges;
}

function unlink(provinces, a, b) {
    provinces[a].neighbours = provinces[a].neighbours.filter((n) => n !== b);
    provinces[b].neighbours = provinces[b].neighbours.filter((n) => n !== a);
}

function link(provinces, a, b) {
    provinces[a].neighbours.push(b);
    provinces[b].neighbours.push(a);
}

function isConnected(provinces) {
    const seen = new Set([0]);
    const queue = [0];
    while (queue.length) {
        for (const n of provinces[queue.shift()].neighbours) {
            if (!seen.has(n)) {
                seen.add(n);
                queue.push(n);
            }
        }
    }
    return seen.size === provinces.length;
}

/** Chaikin corner cutting; keeps both endpoints. */
function smooth(line, passes) {
    for (let k = 0; k < passes; k++) {
        const out = [line[0]];
        for (let i = 0; i < line.length - 1; i++) {
            const [x0, y0] = line[i];
            const [x1, y1] = line[i + 1];
            out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
        }
        out.push(line.at(-1));
        line = out;
    }
    return line;
}

/**
 * Thicken a line into a closed outline that tapers to a point at both ends
 * and swells and narrows along the way.
 * @param {Point[]} line
 * @returns {Point[]}
 */
function ribbon(rng, line, width) {
    const phase = rng.range(0, Math.PI * 2);
    const freq = rng.range(2, 4) * Math.PI;
    const left = [];
    const right = [];
    const last = line.length - 1;
    line.forEach(([x, y], i) => {
        const [px, py] = line[Math.max(i - 1, 0)];
        const [nx, ny] = line[Math.min(i + 1, last)];
        const len = Math.hypot(nx - px, ny - py) || 1;
        const t = i / last;
        const half = (width / 2) * Math.sin(Math.PI * t) ** 0.6 * (1 + 0.25 * Math.sin(freq * t + phase));
        const ox = (-(ny - py) / len) * half;
        const oy = ((nx - px) / len) * half;
        left.push([x + ox, y + oy]);
        right.push([x - ox, y - oy]);
    });
    return [...left, ...right.slice(1, -1).reverse()];
}

/* ------------------------------------------------------------------ */
/* Terrain, names, factions                                            */
/* ------------------------------------------------------------------ */

/**
 * Cheap smooth 2D noise: sum of a few randomly oriented sine waves,
 * normalised to [0, 1].
 */
function makeNoise(rng, width, height) {
    const waves = Array.from({ length: 4 }, (_, i) => {
        const angle = rng.range(0, Math.PI * 2);
        const freq = ((i + 1) * rng.range(1.2, 2.2) * Math.PI) / Math.max(width, height);
        return { dx: Math.cos(angle) * freq, dy: Math.sin(angle) * freq, phase: rng.range(0, Math.PI * 2), weight: 1 / (i + 1) };
    });
    const total = waves.reduce((s, w) => s + w.weight, 0);
    return (x, y) => {
        let v = 0;
        for (const w of waves) v += Math.sin(x * w.dx + y * w.dy + w.phase) * w.weight;
        return (v / total + 1) / 2;
    };
}

function uniqueName(rng, used) {
    for (let tries = 0; tries < 50; tries++) {
        const name = rng.pick(NAME_PARTS.start) + rng.pick(NAME_PARTS.middle) + rng.pick(NAME_PARTS.end);
        if (!used.has(name)) {
            used.add(name);
            return name;
        }
    }
    const fallback = `Province ${used.size + 1}`;
    used.add(fallback);
    return fallback;
}

/**
 * Pick `count` province ids spread as far apart as possible, while
 * keeping away from the map edges (corner capitals are too easy to defend
 * and look odd).
 */
function farthestPoints(rng, provinces, count, width, height) {
    const margin = 0.12 * Math.min(width, height);
    const edgeDist = (p) => Math.min(p.center[0], p.center[1], width - p.center[0], height - p.center[1]);
    let candidates = provinces.filter((p) => edgeDist(p) > margin);
    if (candidates.length < count) candidates = provinces;

    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const chosen = [rng.pick(candidates).id];
    while (chosen.length < count) {
        let best = -1;
        let bestScore = -1;
        for (const p of candidates) {
            if (chosen.includes(p.id)) continue;
            const score = Math.min(...chosen.map((c) => dist(p.center, provinces[c].center)));
            if (score > bestScore) {
                bestScore = score;
                best = p.id;
            }
        }
        chosen.push(best);
    }
    return chosen;
}

/**
 * Each faction claims one adjacent free province per round, so
 * territories stay connected and roughly the same size.
 */
function growTerritories(rng, provinces, capitals) {
    const frontiers = capitals.map(() => []);
    capitals.forEach((c, f) => {
        provinces[c].owner = f;
        frontiers[f].push(...provinces[c].neighbours);
    });

    let remaining = provinces.length - capitals.length;
    while (remaining > 0) {
        let progressed = false;
        for (const f of rng.shuffle(capitals.map((_, i) => i))) {
            const free = frontiers[f].filter((id) => provinces[id].owner === -1);
            frontiers[f] = free;
            if (free.length === 0) continue;
            const id = rng.pick(free);
            provinces[id].owner = f;
            frontiers[f].push(...provinces[id].neighbours);
            remaining--;
            progressed = true;
            if (remaining === 0) break;
        }
        if (!progressed) break; // disconnected leftovers (should not happen)
    }
}
