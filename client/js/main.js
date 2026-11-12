/**
 * @file Bootstrap: login check, load campaign, render.
 *
 * Current state: map generation prototype. The seed is read from the URL
 * (?seed=...) so a given map can be shared and reloaded.
 */

import { generateMap } from '/engine/mapgen.js';
import { TERRAINS } from '/engine/config.js';
import { createMapView } from './ui/map.js';

const seedInput = /** @type {HTMLInputElement} */ (document.getElementById('seed'));
const modeButton = document.getElementById('mode');
const info = document.getElementById('province-info');

let map = null;
let mode = 'political';

const view = createMapView(document.getElementById('map'), { onSelect: showProvince });

function load(seed) {
    seedInput.value = seed;
    const url = new URL(location.href);
    url.searchParams.set('seed', seed);
    history.replaceState(null, '', url);

    map = generateMap({ seed });
    view.render(map);
}

function showProvince(p) {
    if (!p) {
        info.hidden = true;
        return;
    }
    const owner = map.factions[p.owner];
    const neighbourNames = p.neighbours.map((n) => map.provinces[n].name).join(', ');
    info.innerHTML = `
        <h2>${p.name}${p.isCapital ? ' ★' : ''}</h2>
        <dl>
            <dt>Owner</dt><dd><span class="swatch" style="background:${owner.color}"></span>${owner.name}</dd>
            <dt>Terrain</dt><dd><span class="swatch" style="background:${TERRAINS[p.terrain].color}"></span>${TERRAINS[p.terrain].label}</dd>
            <dt>Neighbours</dt><dd>${neighbourNames}</dd>
        </dl>`;
    info.hidden = false;
}

document.getElementById('regenerate').addEventListener('click', () => load(seedInput.value.trim() || 'warmind'));
document.getElementById('random').addEventListener('click', () => load(Math.random().toString(36).slice(2, 8)));
seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') load(seedInput.value.trim() || 'warmind');
});
modeButton.addEventListener('click', () => {
    mode = mode === 'political' ? 'terrain' : 'political';
    modeButton.textContent = mode === 'political' ? 'Terrain view' : 'Political view';
    view.setMode(mode);
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') view.select(null);
});

load(new URLSearchParams(location.search).get('seed') || 'warmind');
