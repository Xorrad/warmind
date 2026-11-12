/**
 * @file Battle resolution.
 *
 * Pure functions: the random rolls come from a seeded generator, so a
 * battle can be replayed exactly. See COMBAT in config.js for the rules.
 * An attack can gather several units, from any provinces next to the
 * target.
 */

import { COMBAT, TERRAINS, UNITS } from './config.js';
import { ownerOf } from './units.js';

/**
 * Fighting power of a unit with a terrain modifier.
 * @param {import('./units.js').Unit} unit
 * @param {number} modifier
 */
export function unitPower(unit, modifier = 1) {
    return unit.size * (unit.strength / UNITS.maxStrength) * (0.5 + unit.motivation) * modifier;
}

/** A terrain modifier softened by COMBAT.terrainWeight. */
export function terrainModifier(raw) {
    return 1 + (raw - 1) * COMBAT.terrainWeight;
}

/**
 * The forces of an attack on a province: the attacking units and every
 * unit standing in the province, with their total powers.
 * @param {import('./units.js').Campaign} campaign
 * @param {import('./mapgen.js').GameMap} map
 * @param {number|number[]} attackerIds One unit or several.
 * @param {number} provinceId
 */
export function battleForces(campaign, map, attackerIds, provinceId) {
    const ids = [].concat(attackerIds);
    const attackers = ids.map((id) => campaign.units.find((u) => u.id === id)).filter(Boolean);
    const province = map.provinces[provinceId];
    const terrain = TERRAINS[province.terrain];
    const attackModifier = terrainModifier(terrain.attack);
    const defenseModifier = terrainModifier(terrain.defense);
    const defenders = campaign.units.filter((u) => u.province === provinceId);
    return {
        attackers,
        defenders,
        province,
        attackModifier,
        defenseModifier,
        attackBonus: COMBAT.attackBonus,
        defenseBonus: COMBAT.defenseBonus,
        attackPower: attackers.reduce((sum, u) => sum + unitPower(u, attackModifier), 0) * COMBAT.attackBonus,
        defensePower: defenders.reduce((sum, u) => sum + unitPower(u, defenseModifier), 0) * COMBAT.defenseBonus,
    };
}

/**
 * Chance that the attacker wins: P(a × r1 > d × r2) with r1, r2 uniform in
 * COMBAT.roll. Computed on a fine grid (exact enough for display).
 * @param {number} attackPower
 * @param {number} defensePower
 * @returns {number} Between 0 and 1.
 */
export function winChance(attackPower, defensePower) {
    if (defensePower <= 0) return 1;
    if (attackPower <= 0) return 0;
    const [lo, hi] = COMBAT.roll;
    const steps = 200;
    let wins = 0;
    for (let i = 0; i < steps; i++) {
        const r1 = lo + ((i + 0.5) / steps) * (hi - lo);
        // Fraction of r2 values with d × r2 < a × r1
        const limit = (attackPower * r1) / defensePower;
        wins += Math.min(1, Math.max(0, (limit - lo) / (hi - lo)));
    }
    return wins / steps;
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/** Apply battle losses to a unit; returns the unit, or null if destroyed. */
function takeLosses(unit, { strength, sizeShare, motivation }) {
    const size = unit.size - Math.round(unit.size * clamp(sizeShare, 0, COMBAT.maxSizeLoss));
    const after = {
        ...unit,
        size,
        strength: Math.max(0, Math.round(unit.strength - strength)),
        motivation: Math.round(clamp(unit.motivation + motivation, 0, 1) * 100) / 100,
    };
    return after.size < 1 || after.strength < COMBAT.minStrength ? null : after;
}

/**
 * @typedef {object} UnitOutcome
 * @property {number} id
 * @property {string} name
 * @property {number} faction
 * @property {import('./units.js').Unit} before
 * @property {import('./units.js').Unit|null} after Null when destroyed.
 * @property {number} [retreatedTo] Province id, for beaten defenders.
 * @property {boolean} [surrounded] Destroyed for lack of a retreat.
 *
 * @typedef {object} BattleReport
 * @property {'battle'} type
 * @property {number} province
 * @property {number} attackerFaction
 * @property {number} defenderFaction
 * @property {'attacker'|'defender'} winner
 * @property {boolean} captured Whether the province changed hands.
 * @property {boolean} unopposed True when nobody defended the province.
 * @property {number} attackPower Rolled power.
 * @property {number} defensePower Rolled power.
 * @property {UnitOutcome[]} attackers
 * @property {UnitOutcome[]} defenders
 */

/**
 * Fight for a province. Every attacker must stand next to it. Returns the
 * new campaign (units, owners, battle counter, log) and the report.
 * @param {import('./units.js').Campaign} campaign
 * @param {import('./mapgen.js').GameMap} map
 * @param {number|number[]} attackerIds
 * @param {number} provinceId
 * @param {import('./rng.js').Rng} rng
 * @returns {{ campaign: import('./units.js').Campaign, report: BattleReport }}
 */
export function resolveBattle(campaign, map, attackerIds, provinceId, rng) {
    const forces = battleForces(campaign, map, attackerIds, provinceId);
    const { attackers, defenders } = forces;
    const defenderFaction = ownerOf(campaign, map, provinceId);
    const outcome = (unit, after, extra = {}) => ({ id: unit.id, name: unit.name, faction: unit.faction, before: unit, after, ...extra });

    let winner = 'attacker';
    let attackPower = 0;
    let defensePower = 0;
    let attackerOutcomes;
    const defenderOutcomes = [];

    if (defenders.length === 0) {
        attackerOutcomes = attackers.map((u) => outcome(u, { ...u }));
    } else {
        const [lo, hi] = COMBAT.roll;
        attackPower = forces.attackPower * rng.range(lo, hi);
        defensePower = forces.defensePower * rng.range(lo, hi);
        winner = attackPower > defensePower ? 'attacker' : 'defender';
        const ratio = winner === 'attacker' ? attackPower / defensePower : defensePower / attackPower;
        const loser = {
            strength: COMBAT.strengthLoss * ratio,
            sizeShare: COMBAT.loserSizeLoss * ratio,
            motivation: -COMBAT.motivationLoss,
        };
        const victor = {
            strength: COMBAT.strengthLoss / ratio,
            sizeShare: COMBAT.winnerSizeLoss / ratio,
            motivation: COMBAT.motivationWin,
        };

        attackerOutcomes = attackers.map((u) => outcome(u, takeLosses(u, winner === 'attacker' ? victor : loser)));

        // Beaten defenders fall back to a neighbouring province of theirs
        const retreats = map.provinces[provinceId].neighbours.filter(
            (n) => TERRAINS[map.provinces[n].terrain].passable && ownerOf(campaign, map, n) === defenderFaction,
        );
        for (const d of defenders) {
            const after = takeLosses(d, winner === 'defender' ? victor : loser);
            if (after && winner === 'attacker') {
                if (retreats.length === 0) {
                    defenderOutcomes.push(outcome(d, null, { surrounded: true }));
                    continue;
                }
                const to = rng.pick(retreats);
                defenderOutcomes.push(outcome(d, { ...after, province: to }, { retreatedTo: to }));
            } else {
                defenderOutcomes.push(outcome(d, after));
            }
        }
    }

    // The surviving attackers of a victory move in and take the province
    const captured = winner === 'attacker' && attackerOutcomes.some((o) => o.after);
    if (captured) for (const o of attackerOutcomes) if (o.after) o.after = { ...o.after, province: provinceId };

    const updated = new Map([...attackerOutcomes, ...defenderOutcomes].map((o) => [o.id, o.after]));
    const owners = [...(campaign.owners ?? map.provinces.map((p) => p.owner))];
    if (captured) owners[provinceId] = attackers[0].faction;

    const report = {
        type: 'battle',
        province: provinceId,
        attackerFaction: attackers[0].faction,
        defenderFaction,
        winner,
        captured,
        unopposed: defenders.length === 0,
        attackPower: Math.round(attackPower * 100) / 100,
        defensePower: Math.round(defensePower * 100) / 100,
        attackers: attackerOutcomes,
        defenders: defenderOutcomes,
    };
    const units = campaign.units.flatMap((u) => {
        if (!updated.has(u.id)) return [u];
        const after = updated.get(u.id);
        return after ? [after] : [];
    });
    return {
        report,
        campaign: { ...campaign, units, owners, battles: (campaign.battles ?? 0) + 1, log: [...(campaign.log ?? []), report].slice(-50) },
    };
}
