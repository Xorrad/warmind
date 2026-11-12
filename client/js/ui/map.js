/**
 * @file SVG map rendering, selection and highlights.
 *
 * This module only draws a GameMap and reports clicks; it never changes
 * game state itself.
 */

import { TERRAINS } from '/engine/config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {'political'|'terrain'} MapMode
 */

/**
 * Create a map view inside a container element.
 * @param {HTMLElement} container
 * @param {{ onSelect?: (province: import('/engine/mapgen.js').Province|null) => void }} [callbacks]
 */
export function createMapView(container, { onSelect } = {}) {
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

    svg.addEventListener('click', (e) => {
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
        svg.replaceChildren(provinceLayer, overlayLayer, markerLayer);
        onSelect?.(null);
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

    return { render, setMode, select, get selectedId() { return selectedId; } };
}

/** Create an SVG element with attributes. */
function el(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
}
