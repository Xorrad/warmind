/**
 * @file Validate and apply player/AI actions.
 *
 * An action is a plain object, e.g. { type: 'move', unitId, to }. Every
 * action goes through validateAction() (is it allowed, what does it cost)
 * before applyAction() changes the campaign. Both are pure.
 *
 * Supported: move, attack, strengthen, merge, split. Relocate and
 * ceasefire come with diplomacy.
 */

import { TERRAINS, UNITS, ACTION_COSTS } from './config.js';
import { addUnit, mergeUnits, splitSizes, strengthenUnit, ownerOf, movesLeft } from './units.js';
import { resolveBattle } from './combat.js';
import { createRng } from './rng.js';

/**
 * Whether units may enter or be stationed in a province. Impassable
 * provinces (mountain ranges, seas) can never hold a unit.
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

/**
 * @typedef {{ type: 'move', unitId: number, to: number }
 *   | { type: 'strengthen', unitId: number }
 *   | { type: 'merge', unitId: number, otherId: number }
 *   | { type: 'split', unitId: number }
 *   | { type: 'attack', unitIds: number[], to: number }} Action
 *
 * An attack can also be written { type: 'attack', unitId, to } for a single
 * unit.
 *
 * @typedef {{ ok: true, cost: number } | { ok: false, reason: string, cost?: number }} Validation
 */

/** Cost of moving into a province: base move cost × its terrain's moveCost. */
export function moveCost(province) {
    return ACTION_COSTS.move * (TERRAINS[province.terrain].moveCost ?? 1);
}

/** Units taking part in an attack action. */
export function attackersOf(action) {
    return action.unitIds ?? [action.unitId];
}

/** Cost of an attack with `count` units. */
export function attackCost(count) {
    return ACTION_COSTS.attack + ACTION_COSTS.attackExtraUnit * Math.max(0, count - 1);
}

/**
 * Check an attack: every unit must be the faction's own and stand next to
 * the target, an enemy (passable) province.
 */
function validateAttack(campaign, map, { faction, balance }, action) {
    const ids = attackersOf(action);
    if (!ids.length) return { ok: false, reason: 'Pick at least one unit to attack with.' };
    if (new Set(ids).size !== ids.length) return { ok: false, reason: 'A unit can only join an attack once.' };
    const to = map.provinces[action.to];
    if (!to) return { ok: false, reason: 'Pick a province to attack.' };
    if (!isPassable(to)) return { ok: false, reason: `${to.name} is impassable.` };
    if (ownerOf(campaign, map, to.id) === faction) return { ok: false, reason: `${to.name} is already yours.` };
    for (const id of ids) {
        const unit = campaign.units.find((u) => u.id === id);
        if (!unit) return { ok: false, reason: 'This unit no longer exists.' };
        if (unit.faction !== faction) return { ok: false, reason: 'This unit belongs to another faction.' };
        if (!canMove(map, unit.province, to.id)) return { ok: false, reason: `${unit.name} is not next to ${to.name}.` };
        if (!movesLeft(unit)) return { ok: false, reason: `${unit.name} has already moved today.` };
    }
    const cost = attackCost(ids.length);
    if (cost > balance) return { ok: false, cost, reason: `Needs ${cost} AP, you have ${balance}.` };
    return { ok: true, cost };
}

/**
 * Check an action for a faction with `balance` action points.
 * @param {import('./units.js').Campaign} campaign
 * @param {import('./mapgen.js').GameMap} map
 * @param {{ faction: number, balance: number }} actor
 * @param {Action} action
 * @returns {Validation}
 */
export function validateAction(campaign, map, { faction, balance }, action) {
    if (action.type === 'attack') return validateAttack(campaign, map, { faction, balance }, action);
    const unit = campaign.units.find((u) => u.id === action.unitId);
    if (!unit) return { ok: false, reason: 'This unit no longer exists.' };
    if (unit.faction !== faction) return { ok: false, reason: 'This unit belongs to another faction.' };

    let cost;
    switch (action.type) {
        case 'move': {
            const to = map.provinces[action.to];
            if (!to || to.id === unit.province) return { ok: false, reason: 'Pick a province to move to.' };
            if (!canMove(map, unit.province, to.id)) {
                return { ok: false, reason: isPassable(to) ? `${to.name} is not next to the unit.` : `${to.name} is impassable.` };
            }
            if (ownerOf(campaign, map, to.id) !== faction)
                return { ok: false, reason: `${to.name} is held by another faction: it has to be attacked.` };
            if (!movesLeft(unit)) return { ok: false, reason: `${unit.name} has already moved today.` };
            cost = moveCost(to);
            break;
        }
        case 'strengthen':
            if (unit.strength >= UNITS.maxStrength) return { ok: false, reason: 'The unit is already fully equipped.' };
            cost = ACTION_COSTS.strengthen;
            break;
        case 'merge': {
            const other = campaign.units.find((u) => u.id === action.otherId);
            if (!other || other.id === unit.id) return { ok: false, reason: 'Pick another unit to merge with.' };
            if (other.faction !== faction) return { ok: false, reason: 'Only your own units can be merged.' };
            if (other.province !== unit.province) return { ok: false, reason: 'Both units must stand in the same province.' };
            if (unit.size + other.size > UNITS.maxSize) return { ok: false, reason: `A unit cannot exceed ${UNITS.maxSize} battalions.` };
            cost = ACTION_COSTS.merge;
            break;
        }
        case 'split':
            if (unit.size < UNITS.minSplitSize)
                return { ok: false, reason: `Only units of ${UNITS.minSplitSize} battalions or more can be split.` };
            cost = ACTION_COSTS.split;
            break;
        default:
            return { ok: false, reason: `Unknown action "${action.type}".` };
    }
    if (cost > balance) return { ok: false, cost, reason: `Needs ${cost} AP, you have ${balance}.` };
    return { ok: true, cost };
}

/**
 * Apply a validated action. Does not touch action points: the caller
 * deducts the cost returned by validateAction(). Attacks need the map and
 * add their report to campaign.log.
 * @param {import('./units.js').Campaign} campaign
 * @param {Action} action
 * @param {import('./mapgen.js').GameMap} [map]
 * @returns {import('./units.js').Campaign}
 */
export function applyAction(campaign, action, map) {
    const unit = campaign.units.find((u) => u.id === action.unitId);
    const replace = (updated) => campaign.units.map((u) => (u.id === updated.id ? updated : u));
    switch (action.type) {
        case 'move':
            return { ...campaign, units: replace({ ...unit, province: action.to, movesUsed: (unit.movesUsed ?? 0) + 1 }) };
        case 'strengthen':
            return { ...campaign, units: replace(strengthenUnit(unit)) };
        case 'merge': {
            const other = campaign.units.find((u) => u.id === action.otherId);
            const merged = mergeUnits(unit, other);
            return { ...campaign, units: campaign.units.filter((u) => u.id !== other.id).map((u) => (u.id === unit.id ? merged : u)) };
        }
        case 'attack': {
            // Rolls seeded by the map and the battle number: replayable
            const rng = createRng(`${campaign.seed}:battle:${campaign.battles ?? 0}`);
            const ids = new Set(attackersOf(action));
            const after = resolveBattle(campaign, map, [...ids], action.to, rng).campaign;
            // Attacking uses the day's move of every surviving attacker
            return { ...after, units: after.units.map((u) => (ids.has(u.id) ? { ...u, movesUsed: (u.movesUsed ?? 0) + 1 } : u)) };
        }
        case 'split': {
            const [keep, give] = splitSizes(unit);
            const updated = { ...campaign, units: replace({ ...unit, size: keep }) };
            const { faction, province, strength, motivation, movesUsed } = unit;
            // The new half has used the same moves as the original today
            return addUnit(updated, { faction, province, size: give, strength, motivation, ...(movesUsed ? { movesUsed } : {}) }).campaign;
        }
        default:
            throw new Error(`Cannot apply action "${action.type}".`);
    }
}

/**
 * Provinces a unit could move to right now, with their cost (affordable or
 * not).
 * @param {import('./units.js').Campaign} campaign
 * @param {import('./mapgen.js').GameMap} map
 * @param {number} unitId
 * @returns {{ province: number, cost: number }[]}
 */
export function moveTargets(campaign, map, unitId) {
    const unit = campaign.units.find((u) => u.id === unitId);
    if (!unit || !movesLeft(unit)) return [];
    return map.provinces[unit.province].neighbours
        .map((id) => map.provinces[id])
        .filter((p) => isPassable(p) && ownerOf(campaign, map, p.id) === unit.faction)
        .map((p) => ({ province: p.id, cost: moveCost(p) }));
}

/**
 * Enemy provinces a unit could attack right now.
 * @param {import('./units.js').Campaign} campaign
 * @param {import('./mapgen.js').GameMap} map
 * @param {number} unitId
 * @returns {number[]} Province ids.
 */
export function attackTargets(campaign, map, unitId) {
    const unit = campaign.units.find((u) => u.id === unitId);
    if (!unit || !movesLeft(unit)) return [];
    return map.provinces[unit.province].neighbours.filter(
        (id) => isPassable(map.provinces[id]) && ownerOf(campaign, map, id) !== unit.faction,
    );
}

/**
 * The faction's units that could join an attack on a province: those
 * standing next to it with a move left today.
 * @param {import('./units.js').Campaign} campaign
 * @param {import('./mapgen.js').GameMap} map
 * @param {number} faction
 * @param {number} provinceId
 * @returns {import('./units.js').Unit[]}
 */
export function possibleAttackers(campaign, map, faction, provinceId) {
    return campaign.units.filter((u) => u.faction === faction && movesLeft(u) > 0 && canMove(map, u.province, provinceId));
}
