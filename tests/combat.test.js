import { describe, it, expect } from 'vitest';
import { generateMap } from '../engine/mapgen.js';
import { deployUnits, ownerOf, ownedMap } from '../engine/units.js';
import { validateAction, applyAction, attackTargets, moveTargets, attackCost, possibleAttackers } from '../engine/actions.js';
import { unitPower, winChance, battleForces, resolveBattle, terrainModifier } from '../engine/combat.js';
import { createRng } from '../engine/rng.js';
import { COMBAT, TERRAINS, ACTION_COSTS, UNITS } from '../engine/config.js';

const map = generateMap({ seed: 'demo' });
const player = map.factions.find((f) => f.isPlayer);
const rich = { faction: player.id, balance: 100 };
const base = deployUnits(map);

/** A player unit on a frontline province, and an enemy province next to it. */
function frontline(campaign = base) {
    const front = map.provinces.find((p) => p.owner === player.id && attackTargets({ ...campaign, units: [{ id: -1, faction: player.id, province: p.id }] }, map, -1).length);
    const target = attackTargets({ ...campaign, units: [{ id: -1, faction: player.id, province: front.id }] }, map, -1)[0];
    return { front, target };
}

/** Campaign with a custom attacker on `from` and custom defenders on `to`. */
function setup({ attacker = {}, defenders = [] } = {}) {
    const { front, target } = frontline();
    const others = base.units.filter((u) => u.province !== front.id && u.province !== target);
    const a = { id: 1000, name: 'Attacker', faction: player.id, province: front.id, size: 4, strength: 80, motivation: 0.5, ...attacker };
    const defenderFaction = map.provinces[target].owner;
    const ds = defenders.map((d, i) => ({ id: 2000 + i, name: `Defender ${i}`, faction: defenderFaction, province: target, size: 2, strength: 60, motivation: 0.5, ...d }));
    return { campaign: { ...base, units: [...others, a, ...ds] }, front, target, attacker: a, defenders: ds };
}

describe('power and odds', () => {
    it('scales with size, strength, motivation and terrain', () => {
        const u = { size: 4, strength: 50, motivation: 0.5 };
        expect(unitPower(u)).toBe(2);
        expect(unitPower({ ...u, size: 8 })).toBe(4);
        expect(unitPower({ ...u, motivation: 1 })).toBe(3);
        expect(unitPower(u, 1.5)).toBe(3);
    });

    it('gives even odds to equal forces and certainty to crushing ones', () => {
        expect(winChance(5, 5)).toBeCloseTo(0.5, 2);
        expect(winChance(15, 5)).toBe(1);
        expect(winChance(5, 15)).toBe(0);
        // The wide roll keeps the underdog in the game
        expect(winChance(5, 7)).toBeGreaterThan(0.1);
        expect(winChance(5, 0)).toBe(1);
        expect(winChance(5.5, 5)).toBeGreaterThan(winChance(5.2, 5));
    });

    it('uses the attacked terrain (softened) and gives attackers the initiative bonus', () => {
        const { campaign, attacker, target } = setup({ defenders: [{}, { size: 3 }] });
        const f = battleForces(campaign, map, attacker.id, target);
        const t = TERRAINS[map.provinces[target].terrain];
        expect(f.attackModifier).toBeCloseTo(1 + (t.attack - 1) * COMBAT.terrainWeight);
        expect(f.attackPower).toBeCloseTo(unitPower(attacker, terrainModifier(t.attack)) * COMBAT.attackBonus);
        expect(f.defensePower).toBeCloseTo(f.defenders.reduce((s, d) => s + unitPower(d, terrainModifier(t.defense)), 0) * COMBAT.defenseBonus);
        expect(f.defenders).toHaveLength(2);
    });

    it('makes equal forces even on open ground, favours defenders elsewhere, and rewards numbers', () => {
        const u = { size: 2, strength: 70, motivation: 0.5 };
        const odds = (terrain, attackers = 1) => {
            const t = TERRAINS[terrain];
            return winChance(attackers * unitPower(u, terrainModifier(t.attack)) * COMBAT.attackBonus, unitPower(u, terrainModifier(t.defense)) * COMBAT.defenseBonus);
        };
        expect(odds('plains')).toBeCloseTo(0.5, 1);
        for (const t of ['forest', 'hills', 'city', 'mountains']) expect(odds(t)).toBeLessThan(0.45);
        expect(odds('mountains')).toBeGreaterThan(0.05);
        for (const t of ['plains', 'forest', 'hills', 'city', 'mountains']) expect(odds(t, 2)).toBeGreaterThan(0.7);
    });
});

describe('attack validation', () => {
    it('accepts an enemy neighbour and charges the attack cost', () => {
        const { campaign, attacker, target } = setup();
        expect(validateAction(campaign, map, rich, { type: 'attack', unitId: attacker.id, to: target })).toEqual({ ok: true, cost: ACTION_COSTS.attack });
    });

    it('refuses own, impassable, distant provinces and missing AP', () => {
        const { campaign, attacker, front, target } = setup();
        const own = map.provinces[front.id].neighbours.find((n) => ownerOf(campaign, map, n) === player.id);
        if (own !== undefined) expect(validateAction(campaign, map, rich, { type: 'attack', unitId: attacker.id, to: own }).ok).toBe(false);
        const sea = map.provinces.find((p) => p.terrain === 'sea');
        expect(validateAction(campaign, map, rich, { type: 'attack', unitId: attacker.id, to: sea.id }).ok).toBe(false);
        const far = map.provinces.find((p) => p.owner !== player.id && p.owner >= 0 && !map.provinces[front.id].neighbours.includes(p.id));
        expect(validateAction(campaign, map, rich, { type: 'attack', unitId: attacker.id, to: far.id })).toMatchObject({ ok: false, reason: expect.stringMatching(/not next/) });
        expect(validateAction(campaign, map, { faction: player.id, balance: 2 }, { type: 'attack', unitId: attacker.id, to: target })).toMatchObject({ ok: false, cost: ACTION_COSTS.attack });
    });
});

describe('resolveBattle', () => {
    it('captures an undefended province without losses', () => {
        const { campaign, attacker, target } = setup();
        const { campaign: after, report } = resolveBattle(campaign, map, attacker.id, target, createRng(1));
        expect(report).toMatchObject({ winner: 'attacker', captured: true, unopposed: true });
        expect(after.units.find((u) => u.id === attacker.id)).toMatchObject({ province: target, size: attacker.size, strength: attacker.strength });
        expect(ownerOf(after, map, target)).toBe(player.id);
    });

    it('lets a much stronger attacker win, take the province and push survivors back', () => {
        const { campaign, attacker, target } = setup({ attacker: { size: 12, strength: 100, motivation: 1 }, defenders: [{ size: 1, strength: 60 }] });
        const { campaign: after, report } = resolveBattle(campaign, map, attacker.id, target, createRng(1));
        expect(report.winner).toBe('attacker');
        expect(report.captured).toBe(true);
        expect(ownerOf(after, map, target)).toBe(player.id);
        const a = after.units.find((u) => u.id === attacker.id);
        expect(a.province).toBe(target);
        expect(a.strength).toBeLessThanOrEqual(100);
        expect(report.attackers.map((o) => o.id)).toEqual([attacker.id]);
        expect(a.motivation).toBeCloseTo(1); // capped
        // The defender retreated to one of its own provinces, or was destroyed
        const d = report.defenders[0];
        if (d.after) {
            expect(after.units.find((u) => u.id === d.id).province).toBe(d.retreatedTo);
            expect(ownerOf(after, map, d.retreatedTo)).toBe(map.provinces[target].owner);
            expect(map.provinces[target].neighbours).toContain(d.retreatedTo);
        } else {
            expect(after.units.find((u) => u.id === d.id)).toBeUndefined();
        }
    });

    it('repels a much weaker attacker, which stays home and loses more', () => {
        const { campaign, attacker, front, target } = setup({ attacker: { size: 1, strength: 40 }, defenders: [{ size: 8, strength: 100, motivation: 1 }] });
        const { campaign: after, report } = resolveBattle(campaign, map, attacker.id, target, createRng(2));
        expect(report).toMatchObject({ winner: 'defender', captured: false });
        expect(ownerOf(after, map, target)).toBe(map.provinces[target].owner);
        const a = after.units.find((u) => u.id === attacker.id);
        if (a) expect(a.province).toBe(front.id); // stayed home, or was destroyed
        const d = after.units.find((u) => u.id === 2000);
        expect(d.province).toBe(target);
        expect(100 - d.strength).toBeLessThan(attacker.strength - (a?.strength ?? 0));
    });

    it('destroys defenders with nowhere to retreat', () => {
        const { campaign, attacker, target } = setup({ attacker: { size: 12, strength: 100, motivation: 1 }, defenders: [{ size: 1 }] });
        // Give every neighbour of the target to the player: no retreat left
        const owners = [...campaign.owners];
        for (const n of map.provinces[target].neighbours) if (owners[n] >= 0) owners[n] = player.id;
        const { campaign: after, report } = resolveBattle({ ...campaign, owners }, map, attacker.id, target, createRng(3));
        expect(report.winner).toBe('attacker');
        expect(report.defenders[0].after).toBeNull();
        expect(after.units.some((u) => u.id === 2000)).toBe(false);
    });

    it('never leaves units under the minimum strength or without battalions', () => {
        for (let seed = 0; seed < 30; seed++) {
            const { campaign, attacker, target } = setup({ attacker: { size: 3, strength: 50 }, defenders: [{ size: 3, strength: 50 }] });
            const { campaign: after } = resolveBattle(campaign, map, attacker.id, target, createRng(seed));
            for (const u of after.units) {
                expect(u.size).toBeGreaterThanOrEqual(1);
                expect(u.size).toBeLessThanOrEqual(UNITS.maxSize);
                expect(u.strength).toBeGreaterThanOrEqual(COMBAT.minStrength);
            }
        }
    });

    it('is reproducible through applyAction and logs the battle', () => {
        const { campaign, attacker, target } = setup({ defenders: [{ size: 3 }] });
        const action = { type: 'attack', unitId: attacker.id, to: target };
        const a = applyAction(campaign, action, map);
        expect(applyAction(campaign, action, map)).toEqual(a);
        expect(a.battles).toBe(1);
        expect(a.log.at(-1)).toMatchObject({ type: 'battle', province: target, attackerFaction: player.id });
        // The next battle uses the next rolls
        const again = applyAction({ ...campaign, battles: 1 }, action, map);
        expect(again.log.at(-1).attackPower).not.toBe(a.log.at(-1).attackPower);
    });

    it('wins about as often as winChance predicts', () => {
        const { campaign, attacker, target } = setup({ attacker: { size: 4, strength: 70 }, defenders: [{ size: 4, strength: 64 }] });
        const f = battleForces(campaign, map, attacker.id, target);
        const expected = winChance(f.attackPower, f.defensePower);
        let wins = 0;
        const n = 400;
        for (let i = 0; i < n; i++) if (resolveBattle(campaign, map, attacker.id, target, createRng(i)).report.winner === 'attacker') wins++;
        expect(wins / n).toBeCloseTo(expected, 1);
    });
});

describe('ownership', () => {
    it('lets units move into captured provinces and shows them on the map', () => {
        const { campaign, attacker, target } = setup();
        const after = applyAction(campaign, { type: 'attack', unitId: attacker.id, to: target }, map);
        const shown = ownedMap(map, after);
        expect(shown.provinces[target].owner).toBe(player.id);
        expect(shown.provinces.filter((p, i) => p.owner !== map.provinces[i].owner)).toHaveLength(1);
        // A second unit can now walk into the captured province
        const follower = { ...attacker, id: 3000, province: attacker.province === target ? map.provinces[target].neighbours[0] : attacker.province };
        const withFollower = { ...after, units: [...after.units, { ...follower, province: campaign.units.find((u) => u.id === attacker.id).province }] };
        expect(moveTargets(withFollower, map, 3000).map((t) => t.province)).toContain(target);
    });

    it('falls back to the map for campaigns saved before ownership', () => {
        const { owners: _owners, ...old } = base;
        expect(ownerOf(old, map, 5)).toBe(map.provinces[5].owner);
        expect(ownedMap(map, old)).toBe(map);
    });
});

describe('attacks with several units', () => {
    /** Two player units on different provinces next to the same enemy target. */
    function pincer() {
        for (const target of map.provinces) {
            if (target.owner === player.id || target.owner < 0) continue;
            const from = target.neighbours.filter((n) => map.provinces[n].owner === player.id && TERRAINS[map.provinces[n].terrain].passable);
            if (from.length < 2) continue;
            const others = base.units.filter((u) => ![target.id, ...from].includes(u.province));
            const a = { id: 1000, name: 'North', faction: player.id, province: from[0], size: 2, strength: 70, motivation: 0.5 };
            const b = { id: 1001, name: 'South', faction: player.id, province: from[1], size: 2, strength: 70, motivation: 0.5 };
            const d = { id: 2000, name: 'Garrison', faction: target.owner, province: target.id, size: 3, strength: 70, motivation: 0.5 };
            return { campaign: { ...base, units: [...others, a, b, d] }, target: target.id, a, b, d };
        }
        throw new Error('no pincer on this map');
    }

    it('adds up the attackers and costs extra AP per extra unit', () => {
        const { campaign, target, a, b } = pincer();
        const one = battleForces(campaign, map, [a.id], target);
        const two = battleForces(campaign, map, [a.id, b.id], target);
        expect(two.attackPower).toBeCloseTo(2 * one.attackPower);
        expect(winChance(two.attackPower, two.defensePower)).toBeGreaterThan(winChance(one.attackPower, one.defensePower));
        expect(attackCost(1)).toBe(ACTION_COSTS.attack);
        expect(attackCost(3)).toBe(ACTION_COSTS.attack + 2 * ACTION_COSTS.attackExtraUnit);
        expect(validateAction(campaign, map, rich, { type: 'attack', unitIds: [a.id, b.id], to: target })).toEqual({ ok: true, cost: attackCost(2) });
    });

    it('lists the units able to join, from every province next to the target', () => {
        const { campaign, target, a, b } = pincer();
        const ids = possibleAttackers(campaign, map, player.id, target).map((u) => u.id);
        expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
        for (const id of ids) expect(map.provinces[campaign.units.find((u) => u.id === id).province].neighbours).toContain(target);
    });

    it('refuses duplicates, distant units, enemy units and empty attacks', () => {
        const { campaign, target, a, d } = pincer();
        const far = base.units.find((u) => u.faction === player.id && !map.provinces[u.province].neighbours.includes(target));
        const attack = (unitIds) => validateAction({ ...campaign, units: [...campaign.units, far] }, map, rich, { type: 'attack', unitIds, to: target });
        expect(attack([a.id, a.id]).ok).toBe(false);
        expect(attack([a.id, far.id])).toMatchObject({ ok: false, reason: expect.stringMatching(/not next/) });
        expect(attack([a.id, d.id]).ok).toBe(false);
        expect(attack([]).ok).toBe(false);
    });

    it('makes every attacker share the outcome; survivors of a victory move in', () => {
        const { campaign, target, a, b } = pincer();
        const checked = { won: false, lost: false };
        for (let seed = 0; seed < 40 && !(checked.won && checked.lost); seed++) {
            const { campaign: after, report } = resolveBattle(campaign, map, [a.id, b.id], target, createRng(seed));
            expect(report.attackers.map((o) => o.id)).toEqual([a.id, b.id]);
            for (const o of report.attackers) {
                const unit = after.units.find((u) => u.id === o.id);
                if (!o.after) expect(unit).toBeUndefined();
                else if (report.captured) expect(unit.province).toBe(target);
                else expect(unit.province).toBe(o.before.province);
            }
            checked[report.winner === 'attacker' ? 'won' : 'lost'] = true;
        }
        expect(checked).toEqual({ won: true, lost: true });
    });
});

describe('attacks and daily moves', () => {
    it('use up the move of every attacker, and need one', () => {
        const { campaign, attacker, target } = setup({ defenders: [{ size: 1, strength: 20 }] });
        const after = applyAction(campaign, { type: 'attack', unitIds: [attacker.id], to: target }, map);
        const unit = after.units.find((u) => u.id === attacker.id);
        if (unit) expect(unit.movesUsed).toBe(1);
        const tired = { ...campaign, units: campaign.units.map((u) => (u.id === attacker.id ? { ...u, movesUsed: 1 } : u)) };
        expect(validateAction(tired, map, rich, { type: 'attack', unitIds: [attacker.id], to: target })).toMatchObject({ ok: false, reason: expect.stringMatching(/already moved/) });
        expect(attackTargets(tired, map, attacker.id)).toEqual([]);
        expect(possibleAttackers(tired, map, player.id, target).some((u) => u.id === attacker.id)).toBe(false);
    });
});
