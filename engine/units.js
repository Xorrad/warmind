/**
 * @file Units: starting deployment and unit operations (merge, split,
 * strengthen).
 *
 * The state of a campaign lives in a plain object owned by the engine:
 *   { seed, units, nextId, numbers, owners, battles, log }
 * where `numbers` holds the next regiment number of each faction (used to
 * name new units "1st Division", "2nd Division"…) and `owners` the owner of
 * each province, which changes when provinces are captured. Every function
 * here is pure and returns new objects.
 */

import { UNITS } from './config.js';
import { createRng } from './rng.js';

/**
 * @typedef {object} Unit
 * @property {number} id
 * @property {string} name
 * @property {number} faction Faction id.
 * @property {number} province Province id where the unit stands.
 * @property {number} size Battalions, 1 to UNITS.maxSize.
 * @property {number} strength Equipment, 0 to UNITS.maxStrength.
 * @property {number} motivation 0 to 1.
 * @property {number} [movesUsed] Moves and attacks made today (missing = 0).
 *
 * @typedef {object} Campaign
 * @property {string} seed Map seed the units belong to.
 * @property {Unit[]} units
 * @property {number} nextId Id of the next unit created.
 * @property {Record<number, number>} numbers Next regiment number per faction.
 * @property {number[]} [owners] Owner of each province (faction id, -1 for
 *   impassable ones); missing in campaigns saved before combat existed.
 * @property {number} [battles] Battles fought, seeds the next battle's rolls.
 * @property {object[]} [log] Latest events (battle reports), oldest first.
 */

/**
 * Current owner of a province: from the campaign, or from the generated map
 * for campaigns saved before ownership could change.
 * @param {Campaign} campaign
 * @param {import('./mapgen.js').GameMap} map
 * @param {number} provinceId
 */
export function ownerOf(campaign, map, provinceId) {
    return campaign.owners?.[provinceId] ?? map.provinces[provinceId].owner;
}

/**
 * The map with the campaign's current owners, for display. Provinces whose
 * owner did not change are reused as they are.
 * @param {import('./mapgen.js').GameMap} map
 * @param {Campaign} campaign
 * @returns {import('./mapgen.js').GameMap}
 */
export function ownedMap(map, campaign) {
    if (!campaign?.owners) return map;
    return {
        ...map,
        provinces: map.provinces.map((p) =>
            campaign.owners[p.id] === p.owner || campaign.owners[p.id] === undefined ? p : { ...p, owner: campaign.owners[p.id] },
        ),
    };
}

/** "1st", "2nd", "3rd", "4th", "11th", "21st"… */
export function ordinal(n) {
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
    return `${n}${suffix}`;
}

/**
 * Add a new unit for a faction, named after its next regiment number.
 * @param {Campaign} campaign
 * @param {Omit<Unit, 'id'|'name'>} fields
 * @returns {{ campaign: Campaign, unit: Unit }}
 */
export function addUnit(campaign, fields) {
    const number = campaign.numbers[fields.faction] ?? 1;
    const unit = { id: campaign.nextId, name: `${ordinal(number)} Division`, ...fields };
    return {
        unit,
        campaign: {
            ...campaign,
            units: [...campaign.units, unit],
            nextId: campaign.nextId + 1,
            numbers: { ...campaign.numbers, [fields.faction]: number + 1 },
        },
    };
}

/**
 * Starting units of every faction: one on the capital, then one per
 * UNITS.provincesPerUnit provinces, on border provinces first.
 * Deterministic for a given map.
 * @param {import('./mapgen.js').GameMap} map
 * @returns {Campaign}
 */
export function deployUnits(map) {
    const rng = createRng(`${map.seed}:units`);
    const { start } = UNITS;
    let campaign = { seed: map.seed, units: [], nextId: 1, numbers: {}, owners: map.provinces.map((p) => p.owner), battles: 0, log: [] };

    for (const faction of map.factions) {
        const owned = map.provinces.filter((p) => p.owner === faction.id);
        const fields = (province, size) => ({
            faction: faction.id,
            province,
            size,
            strength: start.strength,
            motivation: start.motivation,
        });
        campaign = addUnit(campaign, fields(faction.capital, start.capitalSize)).campaign;

        const isFront = (p) => p.neighbours.some((n) => map.provinces[n].owner !== faction.id);
        const others = owned.filter((p) => p.id !== faction.capital);
        const candidates = [...rng.shuffle(others.filter(isFront)), ...rng.shuffle(others.filter((p) => !isFront(p)))];
        const extra = Math.min(Math.floor(owned.length / UNITS.provincesPerUnit), candidates.length);
        for (const p of candidates.slice(0, extra)) campaign = addUnit(campaign, fields(p.id, start.size)).campaign;
    }
    return campaign;
}

/** Moves (or attacks) a unit has left today. */
export function movesLeft(unit) {
    return Math.max(0, UNITS.movesPerDay - (unit.movesUsed ?? 0));
}

/**
 * A new day: every unit gets its moves back.
 * @param {Campaign} campaign
 * @param {(unit: Unit) => boolean} [which] Only these units (all by default).
 * @returns {Campaign}
 */
export function refreshMoves(campaign, which = () => true) {
    return { ...campaign, units: campaign.units.map((u) => (which(u) && u.movesUsed ? { ...u, movesUsed: 0 } : u)) };
}

/**
 * Two units become one. Sizes add up; strength and motivation are averaged,
 * weighted by size. The result keeps the first unit's id and name, and the
 * moves already used by either (merging cannot give moves back).
 * @param {Unit} a
 * @param {Unit} b
 * @returns {Unit}
 */
export function mergeUnits(a, b) {
    const size = a.size + b.size;
    const weighted = (key) => (a[key] * a.size + b[key] * b.size) / size;
    const movesUsed = Math.max(a.movesUsed ?? 0, b.movesUsed ?? 0);
    return {
        ...a,
        size,
        strength: Math.round(weighted('strength')),
        motivation: Math.round(weighted('motivation') * 100) / 100,
        ...(movesUsed ? { movesUsed } : {}),
    };
}

/**
 * Sizes of the two halves of a split: the original keeps the larger one.
 * Strength and motivation are kept by both.
 * @param {Unit} unit
 * @returns {[number, number]}
 */
export function splitSizes(unit) {
    return [Math.ceil(unit.size / 2), Math.floor(unit.size / 2)];
}

/**
 * Resupply a unit: strength goes up by UNITS.strengthenAmount, up to the max.
 * @param {Unit} unit
 * @returns {Unit}
 */
export function strengthenUnit(unit) {
    return { ...unit, strength: Math.min(UNITS.maxStrength, unit.strength + UNITS.strengthenAmount) };
}

/** Units standing in a province. */
export function unitsIn(campaign, provinceId) {
    return campaign.units.filter((u) => u.province === provinceId);
}
