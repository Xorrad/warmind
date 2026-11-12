/**
 * @file Validate and apply player/AI actions.
 */

import { TERRAINS } from './config.js';

/**
 * Whether units may enter or be stationed in a province. Impassable
 * provinces (mountain ranges) can never hold a unit.
 * @param {import('./mapgen.js').Province} province
 * @returns {boolean}
 */
export function isPassable(province) {
    return TERRAINS[province.terrain].passable;
}

/**
 * Whether a unit can move from one province to another in a single step:
 * the provinces must be adjacent (not separated by a mountain range) and
 * the destination must be passable.
 * @param {import('./mapgen.js').GameMap} map
 * @param {number} fromId
 * @param {number} toId
 * @returns {boolean}
 */
export function canMove(map, fromId, toId) {
    const from = map.provinces[fromId];
    const to = map.provinces[toId];
    if (!from || !to) return false;
    return isPassable(from) && isPassable(to) && from.neighbours.includes(toId);
}
