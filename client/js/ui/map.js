/**
 * @file SVG map rendering, selection and highlights.
 *
 * This module only draws a GameMap and reports clicks; it never changes
 * game state itself.
 */

import { TERRAINS } from '/engine/config.js';
import { movesLeft } from '/engine/units.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {'political'|'terrain'} MapMode
 */

/**
 * Create a map view inside a container element.
 * @param {HTMLElement} container
 * @param {{
 *   onSelect?: (province: import('/engine/mapgen.js').Province|null) => void,
 *   onUnitClick?: (unitId: number, event: MouseEvent) => void,
 * }} [callbacks]
 */
export function createMapView(container, { onSelect, onUnitClick } = {}) {
    /** @type {import('/engine/mapgen.js').GameMap|null} */
    let map = null;
    /** @type {MapMode} */
    let mode = 'political';
    let selectedId = null;
    /** @type {Map<number, SVGPathElement>} */
    const paths = new Map();

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    container.replaceChildren(svg);
    let unitLayer = el('g', { class: 'units' });
    let targetLayer = el('g', { class: 'targets' });
    let effectLayer = el('g', { class: 'effects' });
    let focusTimer = null;

    svg.addEventListener('click', (e) => {
        const counter = e.target.closest?.('[data-unit-id]');
        if (counter) {
            onUnitClick?.(Number(counter.dataset.unitId), e);
            return;
        }
        const id = e.target.dataset?.id;
        select(id === undefined ? null : Number(id));
    });

    function fillFor(province) {
        const terrain = TERRAINS[province.terrain];
        // Impassable provinces have no owner: always show their terrain
        return mode === 'terrain' || !terrain.passable ? terrain.color : map.factions[province.owner].color;
    }

    /** Draw (or redraw) the whole map. */
    function render(newMap) {
        map = newMap;
        selectedId = null;
        paths.clear();
        svg.setAttribute('viewBox', `0 0 ${map.width} ${map.height}`);

        const provinceLayer = el('g', { class: 'provinces' });
        // Overlays (mountain ranges) lie on top of the borders they follow
        const overlayLayer = el('g', { class: 'overlays' });
        const markerLayer = el('g', { class: 'markers' });

        for (const p of map.provinces) {
            const terrain = TERRAINS[p.terrain];
            const path = el('path', {
                class: `province terrain-${p.terrain}${terrain.passable ? '' : ' impassable'}`,
                d: `M${p.polygon.map((pt) => pt.join(',')).join('L')}Z`,
                'data-id': p.id,
                fill: fillFor(p),
            });
            const title = el('title');
            title.textContent = `${p.name} (${TERRAINS[p.terrain].label})`;
            path.append(title);
            paths.set(p.id, path);
            (terrain.overlay ? overlayLayer : provinceLayer).append(path);

            if (p.isCapital) {
                markerLayer.append(el('circle', { class: 'capital-marker', cx: p.center[0], cy: p.center[1], r: 9 }));
                const label = el('text', { class: 'province-label', x: p.center[0], y: p.center[1] - 16 });
                label.textContent = p.name;
                markerLayer.append(label);
            }
        }
        targetLayer = el('g', { class: 'targets' });
        effectLayer = el('g', { class: 'effects' });
        unitLayer = el('g', { class: 'units' });
        svg.replaceChildren(provinceLayer, overlayLayer, markerLayer, targetLayer, effectLayer, unitLayer);
        onSelect?.(null);
    }

    /**
     * Draw unit counters: a box in the owner's colour with the unit size and
     * a strength bar, side by side when several share a province.
     * @param {import('/engine/units.js').Unit[]} units
     * @param {{ selectedIds?: number[], candidates?: number[] }} [state]
     */
    function renderUnits(units, { selectedIds = [], candidates = [] } = {}) {
        if (!map) return;
        const byProvince = new Map();
        for (const u of units) byProvince.set(u.province, [...(byProvince.get(u.province) ?? []), u]);
        const counters = [];
        for (const [provinceId, here] of byProvince) {
            const p = map.provinces[provinceId];
            // Below the capital marker, centred on the province otherwise
            const [cx, cy] = [p.center[0], p.center[1] + (p.isCapital ? 18 : 0)];
            here.forEach((u, i) => {
                const x = cx + (i - (here.length - 1) / 2) * 30;
                const classes = [
                    'unit',
                    selectedIds.includes(u.id) && 'selected',
                    candidates.includes(u.id) && 'candidate',
                    !movesLeft(u) && 'spent',
                ]
                    .filter(Boolean)
                    .join(' ');
                const g = el('g', { class: classes, transform: `translate(${x},${cy})`, 'data-unit-id': u.id });
                const title = el('title');
                title.textContent = `${u.name} (${map.factions[u.faction].name}): ${u.size} battalions, strength ${u.strength}%${movesLeft(u) ? '' : ', already moved today'}`;
                g.append(
                    title,
                    el('rect', { class: 'unit-box', x: -13, y: -10, width: 26, height: 20, rx: 3, fill: map.factions[u.faction].color }),
                    el('rect', { class: 'unit-bar-bg', x: -10, y: 5, width: 20, height: 3 }),
                    el('rect', { class: 'unit-bar', x: -10, y: 5, width: (20 * u.strength) / 100, height: 3 }),
                );
                const size = el('text', { class: 'unit-size', x: 0, y: 2 });
                size.textContent = String(u.size);
                g.append(size);
                counters.push(g);
            });
        }
        unitLayer.replaceChildren(...counters);
    }

    /**
     * Mark the provinces the selected unit can move to (yellow) or attack
     * (red), each with a short label (cost, win chance).
     * @param {{ province: number, kind: 'move'|'attack', label: string, affordable: boolean }[]} targets
     */
    function showTargets(targets) {
        for (const path of paths.values()) path.classList.remove('move-target', 'attack-target', 'unaffordable');
        const labels = [];
        for (const t of targets) {
            const path = paths.get(t.province);
            path.classList.add(`${t.kind}-target`);
            if (!t.affordable) path.classList.add('unaffordable');
            const [x, y] = map.provinces[t.province].center;
            const label = el('text', { class: `target-label ${t.kind}${t.affordable ? '' : ' unaffordable'}`, x, y: y - 16 });
            label.textContent = t.label;
            labels.push(label);
        }
        targetLayer.replaceChildren(...labels);
    }

    /**
     * Show what happened until clearHighlight(): an arrow from each
     * attacker's province to the attacked one, captured provinces flashing
     * then lit, held ones outlined.
     * @param {{ province: number, from: number[], captured: boolean, color: string }[]} events
     */
    function highlight(events) {
        clearHighlight();
        const shapes = [];
        for (const e of events) {
            paths.get(e.province)?.classList.add(e.captured ? 'flash-captured' : 'flash-held');
            const [tx, ty] = map.provinces[e.province].center;
            for (const from of e.from) {
                if (from === e.province) continue;
                const [fx, fy] = map.provinces[from].center;
                const len = Math.hypot(tx - fx, ty - fy) || 1;
                const [ux, uy] = [(tx - fx) / len, (ty - fy) / len];
                // Stop short of both centres, end with an arrowhead
                const [sx, sy] = [fx + ux * 10, fy + uy * 10];
                const [ex, ey] = [tx - ux * 14, ty - uy * 14];
                const head = [
                    [ex + ux * 10, ey + uy * 10],
                    [ex - uy * 7, ey + ux * 7],
                    [ex + uy * 7, ey - ux * 7],
                ];
                const g = el('g', { class: 'attack-arrow', style: `--arrow-color:${e.color}` });
                g.append(el('line', { x1: sx, y1: sy, x2: ex, y2: ey }), el('polygon', { points: head.map((p) => p.join(',')).join(' ') }));
                shapes.push(g);
            }
        }
        effectLayer.replaceChildren(...shapes);
    }

    /** Remove the arrows and province highlights of highlight(). */
    function clearHighlight() {
        effectLayer.replaceChildren();
        for (const path of paths.values()) path.classList.remove('flash-captured', 'flash-held');
    }

    /** Select a province and make it pulse for a moment, to find it on the map. */
    function focus(id) {
        select(id);
        const path = paths.get(id);
        if (!path) return;
        clearTimeout(focusTimer);
        path.classList.remove('focus-pulse');
        void path.getBBox(); // restart the animation
        path.classList.add('focus-pulse');
        focusTimer = setTimeout(() => path.classList.remove('focus-pulse'), 2500);
    }

    /** Recolour provinces after their owners changed (captures). */
    function recolor(newMap) {
        map = newMap;
        for (const p of map.provinces) paths.get(p.id).setAttribute('fill', fillFor(p));
    }

    /** Switch between political (owners) and terrain colouring. */
    function setMode(newMode) {
        mode = newMode;
        if (!map) return;
        for (const p of map.provinces) paths.get(p.id).setAttribute('fill', fillFor(p));
    }

    /** Select a province (or null to clear) and highlight its neighbours. */
    function select(id) {
        for (const path of paths.values()) path.classList.remove('selected', 'neighbour');
        selectedId = id;
        if (id === null || !map) {
            onSelect?.(null);
            return;
        }
        const province = map.provinces[id];
        const path = paths.get(id);
        path.classList.add('selected');
        path.parentNode.append(path); // bring to front so the outline is fully visible
        for (const n of province.neighbours) paths.get(n).classList.add('neighbour');
        onSelect?.(province);
    }

    return {
        render,
        renderUnits,
        showTargets,
        highlight,
        clearHighlight,
        focus,
        recolor,
        setMode,
        select,
        get selectedId() {
            return selectedId;
        },
    };
}

/** Create an SVG element with attributes. */
function el(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
}
