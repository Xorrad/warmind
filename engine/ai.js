/**
 * @file Enemy faction turns.
 *
 * A simple greedy AI (see AI in config.js). Each settled day, every faction
 * but the player's earns action points and spends them on actions that go
 * through the same validateAction() / applyAction() as the player's, in
 * this order of preference:
 *  1. the attack with the best odds, if at least AI.minOdds (all of its
 *     units next to the target join);
 *  2. resupplying its weakest front unit;
 *  3. merging two small units standing together;
 *  4. moving a unit from the interior one step towards the front.
 * Everything is deterministic for a given campaign and day.
 */

import { AI, POINTS, TERRAINS } from './config.js';
import { validateAction, applyAction, attackTargets, possibleAttackers } from './actions.js';
import { battleForces, winChance } from './combat.js';
import { ownerOf, refreshMoves } from './units.js';

/** Provinces a faction owns. */
function ownedProvinces(campaign, map, faction) {
    return map.provinces.filter((p) => ownerOf(campaign, map, p.id) === faction);
}

/** Daily action points of an AI faction. */
export function aiIncome(campaign, map, faction) {
    const owned = ownedProvinces(campaign, map, faction).length;
    return Math.round((POINTS.base + POINTS.perProvince * owned) * AI.incomeFactor);
}

/** Whether a province of the faction touches another faction's land. */
function isFront(campaign, map, faction, provinceId) {
    return map.provinces[provinceId].neighbours.some((n) => TERRAINS[map.provinces[n].terrain].passable && ownerOf(campaign, map, n) !== faction);
}

/**
 * First step from a province towards the nearest front province, through
 * the faction's own land, or null when there is no way.
 */
function stepTowardsFront(campaign, map, faction, from) {
    const passableOwn = (id) => TERRAINS[map.provinces[id].terrain].passable && ownerOf(campaign, map, id) === faction;
    const firstStep = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
        const id = queue.shift();
        if (id !== from && isFront(campaign, map, faction, id)) return firstStep.get(id);
        for (const n of map.provinces[id].neighbours) {
            if (firstStep.has(n) || !passableOwn(n)) continue;
            firstStep.set(n, firstStep.get(id) ?? n);
            queue.push(n);
        }
    }
    return null;
}

/** The attack with the best odds the faction could make now. */
function bestAttack(campaign, map, faction) {
    const targets = new Set(campaign.units.filter((u) => u.faction === faction).flatMap((u) => attackTargets(campaign, map, u.id)));
    let best = null;
    for (const to of targets) {
        const units = possibleAttackers(campaign, map, faction, to).map((u) => u.id);
        const f = battleForces(campaign, map, units, to);
        const chance = winChance(f.attackPower, f.defensePower);
        // Prefer better odds, then weaker defences
        if (!best || chance > best.chance || (chance === best.chance && f.defensePower < best.defense)) {
            best = { action: { type: 'attack', unitIds: units, to }, chance, defense: f.defensePower };
        }
    }
    return best;
}

/** The next action the faction wants to take, or null. */
function chooseAction(campaign, map, faction, balance) {
    const affordable = (action) => validateAction(campaign, map, { faction, balance }, action).ok;
    const units = campaign.units.filter((u) => u.faction === faction);

    const attack = bestAttack(campaign, map, faction);
    if (attack && attack.chance >= AI.minOdds && affordable(attack.action)) return attack.action;

    const weak = units
        .filter((u) => u.strength < AI.strengthenBelow && isFront(campaign, map, faction, u.province))
        .sort((a, b) => a.strength - b.strength)[0];
    if (weak && affordable({ type: 'strengthen', unitId: weak.id })) return { type: 'strengthen', unitId: weak.id };

    for (const a of units) {
        const b = units.find((o) => o.id !== a.id && o.province === a.province && a.size + o.size <= AI.mergeUpTo);
        if (b && affordable({ type: 'merge', unitId: a.id, otherId: b.id })) return { type: 'merge', unitId: a.id, otherId: b.id };
    }

    for (const u of units) {
        if (isFront(campaign, map, faction, u.province)) continue;
        const to = stepTowardsFront(campaign, map, faction, u.province);
        if (to !== null && affordable({ type: 'move', unitId: u.id, to })) return { type: 'move', unitId: u.id, to };
    }
    return null;
}

/**
 * One faction's turn: spend its action points.
 * @param {import('./units.js').Campaign} campaign
 * @param {import('./mapgen.js').GameMap} map
 * @param {number} faction
 * @returns {{ campaign: import('./units.js').Campaign, actions: object[] }}
 */
export function playFaction(campaign, map, faction) {
    const actions = [];
    let balance = campaign.ai?.[faction] ?? 0;
    for (let i = 0; i < AI.maxActions; i++) {
        const action = chooseAction(campaign, map, faction, balance);
        if (!action) break;
        const v = validateAction(campaign, map, { faction, balance }, action);
        if (!v.ok) break;
        campaign = applyAction(campaign, action, map);
        balance -= v.cost;
        actions.push(action);
    }
    return { campaign: { ...campaign, ai: { ...campaign.ai, [faction]: balance } }, actions };
}

/**
 * A day of enemy turns: every AI faction still holding land earns its
 * income, then plays, in faction order.
 * @param {import('./units.js').Campaign} campaign
 * @param {import('./mapgen.js').GameMap} map
 * @param {string} day YYYY-MM-DD, recorded on the reports.
 * @returns {{ campaign: import('./units.js').Campaign, reports: object[] }}
 */
export function playDay(campaign, map, day) {
    const battlesStart = campaign.battles ?? 0;
    for (const faction of map.factions) {
        if (faction.isPlayer || ownedProvinces(campaign, map, faction.id).length === 0) continue;
        const income = aiIncome(campaign, map, faction.id);
        const saved = Math.min((campaign.ai?.[faction.id] ?? 0) + income, income * AI.maxSavingsDays);
        const rested = refreshMoves(campaign, (u) => u.faction === faction.id);
        campaign = playFaction({ ...rested, ai: { ...rested.ai, [faction.id]: saved } }, map, faction.id).campaign;
    }
    // The battles of the day are the last ones of the log
    const fought = (campaign.battles ?? 0) - battlesStart;
    const reports = fought ? campaign.log.slice(-fought).map((r) => ({ ...r, day })) : [];
    return { campaign, reports };
}

/**
 * Enemy turns for several settled days, in order.
 * @param {import('./units.js').Campaign} campaign
 * @param {import('./mapgen.js').GameMap} map
 * @param {string[]} days
 */
export function playDays(campaign, map, days) {
    const reports = [];
    for (const day of days) {
        const result = playDay(campaign, map, day);
        campaign = result.campaign;
        reports.push(...result.reports);
    }
    return { campaign, reports };
}
