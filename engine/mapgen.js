/**
 * @file Voronoi province generation, terrain, adjacency, factions.
 *
 * Pipeline:
 *  1. scatter random points and relax them (Lloyd) for even province sizes;
 *  2. build the Voronoi diagram: one cell = one province, shared edge = neighbours;
 *  3. make borders jagged (deterministic per edge, so both sides match, and
 *     confined to the two provinces they separate, so they never cross);
 *  4. flood low cells near the map edges into seas, merged in groups of a
 *     few cells;
 *  5. assign land terrain from smooth pseudo-noise;
 *  6. carve impassable mountain ranges along chains of borders;
 *  7. place faction capitals far apart and grow territories round-robin;
 *  8. renumber: land provinces first, then seas, then ranges.
 *
 * While generating, every Voronoi cell is a province whose id is its cell
 * index; seas and ranges only become provinces of their own at step 8.
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
 * @property {number[]} [borders] Impassable provinces only (seas, ranges):
 *   ids of the land provinces they touch.
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
    const cells = Array.from({ length: o.provinceCount }, (_, i) => openRing(voronoi.cellPolygon(i)));
    const sites = Array.from({ length: o.provinceCount }, (_, i) => [points[2 * i], points[2 * i + 1]]);
    const edges = buildEdges(cells, sites, o);
    const provinces = [];
    for (let i = 0; i < o.provinceCount; i++) {
        const raw = cells[i];
        provinces.push({
            id: i,
            name: '',
            terrain: 'plains',
            owner: -1,
            isCapital: false,
            neighbours: [...voronoi.neighbors(i)],
            center: roundPoint(centroid(raw)),
            polygon: roundPolygon(jaggedPolygon(raw, edges)),
        });
    }

    // 3. Names
    const used = new Set();
    for (const p of provinces) p.name = uniqueName(rng, used);

    // 4. Seas (before terrain and factions, which only consider land)
    const elevation = makeNoise(rng, o.width, o.height);
    const moisture = makeNoise(rng, o.width, o.height);
    const seas = pickSeas(rng, provinces, elevation, o);
    const land = provinces.filter((p) => p.terrain !== 'sea');

    // 5. Terrain: rank land by noise so proportions are stable across seeds
    const byElevation = [...land].sort((a, b) => elevation(...b.center) - elevation(...a.center));
    const n = land.length;
    const nMountains = Math.round(n * o.terrainShare.mountains);
    const nHills = Math.round(n * o.terrainShare.hills);
    byElevation.slice(0, nMountains).forEach((p) => (p.terrain = 'mountains'));
    byElevation.slice(nMountains, nMountains + nHills).forEach((p) => (p.terrain = 'hills'));
    const lowlands = byElevation.slice(nMountains + nHills).sort((a, b) => moisture(...b.center) - moisture(...a.center));
    lowlands.slice(0, Math.round(n * o.terrainShare.forest)).forEach((p) => (p.terrain = 'forest'));

    // 6. Mountain ranges (before factions, so territories grow around them)
    const ranges = carveRanges(rng, provinces, edges, elevation, o);

    // 7. Factions
    const factionCount = Math.min(o.factionCount, FACTIONS.length, land.length);
    const capitals = farthestPoints(rng, land, provinces, factionCount, o.width, o.height);
    growTerritories(rng, provinces, land.length, capitals);
    for (const c of capitals) {
        provinces[c].isCapital = true;
        provinces[c].terrain = 'city';
    }

    // 8. Final numbering: land, then seas, then ranges
    const newId = new Map(land.map((p, i) => [p.id, i]));
    const remap = (ids) => ids.map((id) => newId.get(id)).sort((a, b) => a - b);
    const result = land.map((p) => ({ ...p, id: newId.get(p.id), neighbours: remap(p.neighbours) }));
    for (const group of seas) {
        const outline = unionOutline(group, cells, edges);
        const centers = group.map((c) => provinces[c].center);
        const mean = [centers.reduce((s, c) => s + c[0], 0) / centers.length, centers.reduce((s, c) => s + c[1], 0) / centers.length];
        const middle = centers.reduce((best, c) => (Math.hypot(c[0] - mean[0], c[1] - mean[1]) < Math.hypot(best[0] - mean[0], best[1] - mean[1]) ? c : best));
        result.push({
            id: result.length,
            name: seaName(rng, used),
            terrain: 'sea',
            owner: -1,
            isCapital: false,
            neighbours: [],
            borders: remap(outline.borders.filter((c) => provinces[c].terrain !== 'sea')),
            center: middle,
            polygon: roundPolygon(outline.polygon),
        });
    }
    for (const r of ranges) {
        result.push({
            id: result.length,
            name: `${uniqueName(rng, used)} Range`,
            terrain: 'range',
            owner: -1,
            isCapital: false,
            neighbours: [],
            borders: remap(r.borders),
            center: roundPoint(r.spine[Math.floor(r.spine.length / 2)]),
            polygon: roundPolygon(ribbon(rng, smooth(r.spine, 2), o.ranges.width)),
        });
    }
    const factions = capitals.map((capital, id) => ({
        id,
        name: FACTIONS[id].name,
        color: FACTIONS[id].color,
        isPlayer: id === 0,
        capital: newId.get(capital),
    }));

    return { seed, width: o.width, height: o.height, provinces: result, factions };
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

const vertexKey = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;

/**
 * @typedef {object} Edge
 * @property {Point} a
 * @property {Point} b
 * @property {string} ka Key of a.
 * @property {string} kb Key of b.
 * @property {number[]} cells Ids of the one (map border) or two cells sharing it.
 * @property {Point[]} inner Jagged points from a to b, endpoints excluded.
 */

/**
 * Collect every Voronoi edge once, with the cells on each side, and build
 * its jagged line. Edges on the map border stay straight.
 * @returns {Map<string, Edge>}
 */
function buildEdges(cells, sites, o) {
    const edges = new Map();
    cells.forEach((poly, id) => {
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            const [ka, kb] = [vertexKey(a), vertexKey(b)];
            const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            if (!edges.has(k)) edges.set(k, ka < kb ? { a, b, ka, kb, cells: [], inner: [] } : { a: b, b: a, ka: kb, kb: ka, cells: [], inner: [] });
            edges.get(k).cells.push(id);
        }
    });
    for (const [k, e] of edges) {
        if (e.cells.length !== 2) continue;
        e.inner = noisyEdge(e.a, e.b, sites[e.cells[0]], sites[e.cells[1]], createRng(hashString(k)), o);
    }
    return edges;
}

/** Jagged points of the edge from a to b (endpoints excluded), in that direction. */
function edgeLine(edges, a, b) {
    const [ka, kb] = [vertexKey(a), vertexKey(b)];
    const e = edges.get(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
    if (!e) return [];
    return e.ka === ka ? e.inner : [...e.inner].reverse();
}

/** Replace each straight edge of a cell by its jagged line. */
function jaggedPolygon(poly, edges) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        out.push(poly[i], ...edgeLine(edges, poly[i], poly[(i + 1) % poly.length]));
    }
    return out;
}

/**
 * Jagged line between a and b, staying inside the two triangles (a, b, s1)
 * and (a, b, s2) where s1 and s2 are the sites of the cells on either side.
 * Those triangles fan out from each site and never overlap from one edge
 * to another, so borders cannot cross or fold over each other, whatever
 * the jitter.
 *
 * The line is computed as a height v(u) above the segment (u along it,
 * both in edge-length units) by midpoint displacement, then softly
 * squeezed under the triangles' envelope. Since the allowed region is
 * convex in (u, v), the straight pieces between samples stay inside too.
 * @returns {Point[]} Points from a to b, endpoints excluded.
 */
function noisyEdge(a, b, s1, s2, rng, o) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    // Short edges get fewer subdivisions: segments stay at least ~4px long
    const depth = Math.min(o.borderDepth, Math.floor(Math.log2(len / 4)));
    if (len === 0 || depth <= 0) return [];
    const local = ([x, y]) => [((x - a[0]) * dx + (y - a[1]) * dy) / len ** 2, ((x - a[0]) * -dy + (y - a[1]) * dx) / len ** 2];
    const [above, below] = [local(s1), local(s2)].sort((p, q) => q[1] - p[1]);
    if (above[1] <= 0 || below[1] >= 0) return []; // degenerate: sites not on both sides

    // Height of a triangle (u = 0..1 base, apex at site) above the base at u
    const envelope = ([su, sv], u) => {
        const h = Math.abs(sv);
        const left = su > 0 ? u / su : Infinity;
        const right = su < 1 ? (1 - u) / (1 - su) : Infinity;
        return 0.9 * h * Math.min(left, right);
    };

    const n = 2 ** depth;
    const heights = new Array(n + 1).fill(0);
    let amp = o.borderJitter;
    for (let step = n; step > 1; step /= 2) {
        for (let l = 0; l < n; l += step) {
            const r = l + step;
            heights[l + step / 2] = (heights[l] + heights[r]) / 2 + (rng.next() - 0.5) * 2 * amp;
        }
        amp *= o.borderRoughness;
    }

    const out = [];
    for (let i = 1; i < n; i++) {
        const u = i / n;
        const raw = heights[i];
        const limit = raw >= 0 ? envelope(above, u) : envelope(below, u);
        // Where the room left is under a pixel (next to a vertex), stay on
        // the straight edge: rounding the coordinates could cross a neighbour
        const v = limit * len >= 1 ? limit * Math.tanh(raw / limit) : 0;
        out.push([a[0] + dx * u - dy * v, a[1] + dy * u + dx * v]);
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Seas                                                                */
/* ------------------------------------------------------------------ */

/**
 * Turn the lowest cells near the map edges into sea, then group adjacent
 * sea cells into sea provinces of minCells to maxCells cells. A cell is
 * only flooded if the land stays in one piece, and lone sea cells (too
 * small to form a sea) go back to land. Sea cells lose all adjacency.
 * @returns {number[][]} Cell ids of each sea province.
 */
function pickSeas(rng, provinces, elevation, o) {
    const { share, minCells, maxCells } = o.seas;
    if (!share) return [];
    const half = Math.min(o.width, o.height) / 2;
    const edgeDist = (p) => Math.min(p.center[0], p.center[1], o.width - p.center[0], o.height - p.center[1]) / half;
    const score = (p) => 0.4 * elevation(...p.center) + 0.6 * edgeDist(p);
    const target = Math.round(provinces.length * share);

    const sea = new Set();
    for (const p of [...provinces].sort((a, b) => score(a) - score(b))) {
        if (sea.size >= target) break;
        sea.add(p.id);
        if (!isConnected(provinces, sea)) sea.delete(p.id);
    }

    // Connected bodies of water; those smaller than a sea go back to land
    const seaNeighbours = (id) => provinces[id].neighbours.filter((n) => sea.has(n));
    const bodies = [];
    const seen = new Set();
    for (const id of [...sea].sort((a, b) => a - b)) {
        if (seen.has(id)) continue;
        const body = [id];
        seen.add(id);
        for (let i = 0; i < body.length; i++) {
            for (const n of seaNeighbours(body[i])) {
                if (!seen.has(n)) {
                    seen.add(n);
                    body.push(n);
                }
            }
        }
        if (body.length >= minCells) bodies.push(body);
    }

    // Split each body into compact groups, starting from its extremities
    const groups = [];
    for (const body of bodies) {
        const free = new Set(body);
        const bodyGroups = [];
        while (free.size) {
            const freeLinks = (id) => seaNeighbours(id).filter((n) => free.has(n)).length;
            const seed = [...free].sort((a, b) => freeLinks(a) - freeLinks(b) || a - b)[0];
            const size = rng.int(minCells, maxCells);
            const group = [seed];
            free.delete(seed);
            while (group.length < size) {
                const options = [...new Set(group.flatMap(seaNeighbours))].filter((n) => free.has(n));
                if (!options.length) break;
                const links = (id) => seaNeighbours(id).filter((n) => group.includes(n)).length;
                const next = options.sort((a, b) => links(b) - links(a) || a - b)[0];
                group.push(next);
                free.delete(next);
            }
            bodyGroups.push(group);
        }
        // Too-small leftovers join the smallest neighbouring group
        for (const small of bodyGroups.filter((g) => g.length < minCells)) {
            const touching = bodyGroups.filter((g) => g !== small && g.length && g.some((c) => small.some((s) => seaNeighbours(s).includes(c))));
            if (!touching.length) continue;
            const target = touching.sort((a, b) => a.length - b.length)[0];
            target.push(...small.splice(0));
        }
        groups.push(...bodyGroups.filter((g) => g.length));
    }

    // Flood the kept cells: they leave the land graph
    for (const id of groups.flat()) {
        const p = provinces[id];
        p.terrain = 'sea';
        for (const n of p.neighbours) provinces[n].neighbours = provinces[n].neighbours.filter((m) => m !== id);
        p.neighbours = [];
    }
    return groups;
}

/**
 * Outline of a group of adjacent cells: walk the edges that are not shared
 * by two cells of the group, following their jagged lines. Also returns
 * the cells on the other side of those edges.
 * @returns {{ polygon: Point[], borders: number[] }}
 */
function unionOutline(group, cells, edges) {
    const inGroup = new Set(group);
    const next = new Map();
    const borders = new Set();
    for (const c of group) {
        const poly = cells[c];
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            const [ka, kb] = [vertexKey(a), vertexKey(b)];
            const e = edges.get(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
            const other = e.cells.find((x) => x !== c);
            if (other !== undefined && inGroup.has(other)) continue;
            if (other !== undefined) borders.add(other);
            next.set(ka, [a, b]);
        }
    }
    // Chain the edges into loops; keep the outer (largest) one
    const loops = [];
    const done = new Set();
    for (const startKey of next.keys()) {
        const loop = [];
        let k = startKey;
        while (next.has(k) && !done.has(k)) {
            done.add(k);
            const [a, b] = next.get(k);
            loop.push(a, ...edgeLine(edges, a, b));
            k = vertexKey(b);
        }
        if (loop.length >= 3) loops.push(loop);
    }
    const polygon = loops.reduce((best, l) => (Math.abs(area(l)) > Math.abs(area(best)) ? l : best), loops[0] ?? []);
    return { polygon, borders: [...borders] };
}

function seaName(rng, used) {
    for (let tries = 0; tries < 50; tries++) {
        const base = rng.pick(NAME_PARTS.start) + rng.pick(NAME_PARTS.middle) + rng.pick(NAME_PARTS.end);
        const name = rng.chance(0.5) ? `${base} Sea` : `Gulf of ${base}`;
        if (!used.has(name)) {
            used.add(name);
            return name;
        }
    }
    const fallback = `Sea ${used.size + 1}`;
    used.add(fallback);
    return fallback;
}

/* ------------------------------------------------------------------ */
/* Mountain ranges                                                     */
/* ------------------------------------------------------------------ */

/**
 * Lay impassable ranges along winding chains of Voronoi edges. Each edge of
 * a chain separates two provinces, whose adjacency is removed. A chain is
 * rejected if it would split the map in two, so every province stays
 * reachable. Ranges never touch each other or the map edge.
 * @returns {{ spine: Point[], borders: number[] }[]}
 */
function carveRanges(rng, provinces, edges, elevation, o) {
    const { count, minEdges, maxEdges } = o.ranges;
    if (!count) return [];
    const margin = 0.04 * Math.min(o.width, o.height);
    const inside = ([x, y]) => x > margin && y > margin && x < o.width - margin && y < o.height - margin;

    // Graph of Voronoi vertices linked by the interior edges they share
    const vertices = new Map();
    for (const e of edges.values()) {
        if (e.cells.length !== 2 || !inside(e.a) || !inside(e.b)) continue;
        if (e.cells.some((c) => provinces[c].terrain === 'sea')) continue;
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
        let lastDir = null;
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
                if (lastDir !== null && Math.cos(dir - lastDir) < -0.2) continue; // no hairpin
                const score = align + rng.range(0, 0.6);
                if (score > bestScore) {
                    bestScore = score;
                    best = { link, dir };
                }
            }
            if (!best) break;
            path.push(best.link.to);
            steps.push(best.link);
            lastDir = best.dir;
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
            spine.push(...edgeLine(edges, prev, step.point), step.point);
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

/**
 * Whether every land province can reach every other one. Cells in
 * `excluded` (and seas) count as water.
 * @param {Province[]} provinces
 * @param {Set<number>} [excluded]
 */
function isConnected(provinces, excluded = new Set()) {
    const isLand = (p) => p.terrain !== 'sea' && !excluded.has(p.id);
    const land = provinces.filter(isLand);
    if (land.length === 0) return true;
    const seen = new Set([land[0].id]);
    const queue = [land[0].id];
    while (queue.length) {
        for (const n of provinces[queue.shift()].neighbours) {
            if (!seen.has(n) && isLand(provinces[n])) {
                seen.add(n);
                queue.push(n);
            }
        }
    }
    return seen.size === land.length;
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
 *
 * Offsetting the line sideways folds over itself wherever it bends more
 * tightly than the width, so instead the outline is the boundary of every
 * point within the (varying) radius of the line: a distance field sampled
 * on a fine grid and contoured with marching squares.
 * @param {Point[]} line
 * @returns {Point[]}
 */
function ribbon(rng, line, width) {
    const phase = rng.range(0, Math.PI * 2);
    const freq = rng.range(2, 4) * Math.PI;

    // Radius at each point, from its position along the line (by length)
    const along = [0];
    for (let i = 1; i < line.length; i++) along.push(along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    const total = along.at(-1) || 1;
    const radii = along.map((d) => {
        const t = d / total;
        return (width / 2) * Math.sin(Math.PI * t) ** 0.6 * (1 + 0.25 * Math.sin(freq * t + phase));
    });

    // Signed distance to the thick line on a grid (negative = inside)
    const step = Math.max(width / 12, 0.5);
    const pad = Math.max(...radii) + 2 * step;
    const xs = line.map((p) => p[0]);
    const ys = line.map((p) => p[1]);
    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    const nx = Math.ceil((Math.max(...xs) + pad - x0) / step) + 1;
    const ny = Math.ceil((Math.max(...ys) + pad - y0) / step) + 1;
    const field = new Float64Array(nx * ny).fill(Infinity);
    for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = line[i];
        const [bx, by] = line[i + 1];
        const [ra, rb] = [radii[i], radii[i + 1]];
        const reach = Math.max(ra, rb) + 2 * step;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1;
        const gx0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / step));
        const gx1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + reach - x0) / step));
        const gy0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - y0) / step));
        const gy1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + reach - y0) / step));
        for (let gy = gy0; gy <= gy1; gy++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const px = x0 + gx * step;
                const py = y0 + gy * step;
                const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
                const d = Math.hypot(px - ax - t * dx, py - ay - t * dy) - (ra + (rb - ra) * t);
                const k = gy * nx + gx;
                if (d < field[k]) field[k] = d;
            }
        }
    }

    const loops = marchingSquares(field, nx, ny, (gx, gy) => [x0 + gx * step, y0 + gy * step]);
    // Keep the main body (the thin tapered tips can leave specks)
    const main = loops.reduce((best, l) => (Math.abs(area(l)) > Math.abs(area(best)) ? l : best), loops[0] ?? []);
    return simplify(main, step / 4);
}

/**
 * Contour the zero level of a grid field (negative = inside).
 * @param {Float64Array} field Row-major values, nx by ny.
 * @param {(gx: number, gy: number) => Point} toPoint Grid to map coordinates.
 * @returns {Point[][]} Closed loops.
 */
function marchingSquares(field, nx, ny, toPoint) {
    const value = (gx, gy) => field[gy * nx + gx];
    const points = new Map();
    const links = new Map();
    // A crossing on the grid edge from node (gx, gy) going right (h) or down (v)
    const crossing = (gx, gy, dir) => {
        const id = `${gx},${gy},${dir}`;
        if (!points.has(id)) {
            const [hx, hy] = dir === 'h' ? [gx + 1, gy] : [gx, gy + 1];
            const a = value(gx, gy);
            const b = value(hx, hy);
            const t = a / (a - b);
            const [px, py] = toPoint(gx, gy);
            const [qx, qy] = toPoint(hx, hy);
            points.set(id, [px + (qx - px) * t, py + (qy - py) * t]);
        }
        return id;
    };
    const connect = (a, b) => {
        for (const [from, to] of [[a, b], [b, a]]) {
            if (!links.has(from)) links.set(from, []);
            links.get(from).push(to);
        }
    };
    // Cell sides: 0 top, 1 right, 2 bottom, 3 left
    const SEGMENTS = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]] };
    for (let gy = 0; gy < ny - 1; gy++) {
        for (let gx = 0; gx < nx - 1; gx++) {
            const v = [value(gx, gy), value(gx + 1, gy), value(gx + 1, gy + 1), value(gx, gy + 1)];
            const code = (v[0] < 0) | ((v[1] < 0) << 1) | ((v[2] < 0) << 2) | ((v[3] < 0) << 3);
            if (code === 0 || code === 15) continue;
            const side = [() => crossing(gx, gy, 'h'), () => crossing(gx + 1, gy, 'v'), () => crossing(gx, gy + 1, 'h'), () => crossing(gx, gy, 'v')];
            let segments = SEGMENTS[code];
            if (code === 5 || code === 10) {
                // Saddle: the cell centre decides whether the inside corners join
                const centreInside = (v[0] + v[1] + v[2] + v[3]) / 4 < 0;
                segments = (code === 5) === centreInside ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
            }
            for (const [a, b] of segments) connect(side[a](), side[b]());
        }
    }

    const loops = [];
    const seen = new Set();
    for (const startId of links.keys()) {
        if (seen.has(startId)) continue;
        const loop = [];
        let prev = null;
        let id = startId;
        while (id !== undefined && !seen.has(id)) {
            seen.add(id);
            loop.push(points.get(id));
            const next = links.get(id).find((n) => n !== prev && !seen.has(n));
            prev = id;
            id = next;
        }
        if (loop.length >= 3) loops.push(loop);
    }
    return loops;
}

/** Signed area of a polygon (shoelace). */
function area(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i];
        const [x1, y1] = poly[(i + 1) % poly.length];
        a += x0 * y1 - x1 * y0;
    }
    return a / 2;
}

/**
 * Douglas-Peucker simplification of a closed polygon: drop points while
 * staying within `tolerance` of the original outline.
 */
function simplify(poly, tolerance) {
    if (poly.length < 4) return poly;
    // Split the loop at its two most distant points into two open chains
    let far = 0;
    let farDist = -1;
    for (let i = 1; i < poly.length; i++) {
        const d = Math.hypot(poly[i][0] - poly[0][0], poly[i][1] - poly[0][1]);
        if (d > farDist) [far, farDist] = [i, d];
    }
    const first = simplifyChain(poly.slice(0, far + 1), tolerance);
    const second = simplifyChain([...poly.slice(far), poly[0]], tolerance);
    return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function simplifyChain(chain, tolerance) {
    const [ax, ay] = chain[0];
    const [bx, by] = chain.at(-1);
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let index = -1;
    let max = tolerance;
    for (let i = 1; i < chain.length - 1; i++) {
        const [x, y] = chain[i];
        const d = len ? Math.abs((x - ax) * dy - (y - ay) * dx) / len : Math.hypot(x - ax, y - ay);
        if (d > max) [index, max] = [i, d];
    }
    if (index === -1) return [chain[0], chain.at(-1)];
    return [...simplifyChain(chain.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyChain(chain.slice(index), tolerance)];
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

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
function farthestPoints(rng, land, provinces, count, width, height) {
    const margin = 0.12 * Math.min(width, height);
    const edgeDist = (p) => Math.min(p.center[0], p.center[1], width - p.center[0], height - p.center[1]);
    let candidates = land.filter((p) => edgeDist(p) > margin);
    if (candidates.length < count) candidates = land;

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
function growTerritories(rng, provinces, landCount, capitals) {
    const frontiers = capitals.map(() => []);
    capitals.forEach((c, f) => {
        provinces[c].owner = f;
        frontiers[f].push(...provinces[c].neighbours);
    });

    let remaining = landCount - capitals.length;
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
