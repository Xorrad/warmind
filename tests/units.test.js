import { describe, it, expect } from 'vitest';
import { generateMap } from '../engine/mapgen.js';
import { deployUnits, mergeUnits, splitSizes, strengthenUnit, ordinal, addUnit, unitsIn, movesLeft, refreshMoves } from '../engine/units.js';
import { validateAction, applyAction, moveTargets, moveCost, isPassable } from '../engine/actions.js';
import { UNITS, ACTION_COSTS, TERRAINS } from '../engine/config.js';

const map = generateMap({ seed: 'demo' });
const player = map.factions.find((f) => f.isPlayer);
const rich = { faction: player.id, balance: 100 };

const unit = (fields = {}) => ({ id: 1, name: '1st Division', faction: 0, province: 0, size: 4, strength: 60, motivation: 0.5, ...fields });

describe('ordinal', () => {
    it('names regiments in English', () => {
        expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
    });
});

describe('deployUnits', () => {
    const campaign = deployUnits(map);

    it('is deterministic for a map', () => {
        expect(deployUnits(generateMap({ seed: 'demo' }))).toEqual(campaign);
        expect(campaign.seed).toBe('demo');
    });

    it('puts a unit on every capital and one per provincesPerUnit provinces', () => {
        for (const f of map.factions) {
            const own = campaign.units.filter((u) => u.faction === f.id);
            const owned = map.provinces.filter((p) => p.owner === f.id).length;
            expect(own.some((u) => u.province === f.capital && u.size === UNITS.start.capitalSize)).toBe(true);
            expect(own).toHaveLength(1 + Math.floor(owned / UNITS.provincesPerUnit));
        }
    });

    it('only places units in passable provinces their faction owns, one per province', () => {
        for (const u of campaign.units) {
            const p = map.provinces[u.province];
            expect(isPassable(p)).toBe(true);
            expect(p.owner).toBe(u.faction);
        }
        expect(new Set(campaign.units.map((u) => u.province)).size).toBe(campaign.units.length);
    });

    it('gives unique ids and numbers each faction from 1st', () => {
        expect(new Set(campaign.units.map((u) => u.id)).size).toBe(campaign.units.length);
        for (const f of map.factions) {
            const names = campaign.units.filter((u) => u.faction === f.id).map((u) => u.name);
            expect(names[0]).toBe('1st Division');
            expect(new Set(names).size).toBe(names.length);
        }
    });
});

describe('unit operations', () => {
    it('merges sizes and weights strength and motivation by size', () => {
        const m = mergeUnits(unit({ size: 3, strength: 100, motivation: 1 }), unit({ id: 2, size: 1, strength: 20, motivation: 0 }));
        expect(m).toMatchObject({ id: 1, size: 4, strength: 80, motivation: 0.75 });
    });

    it('splits into a larger and a smaller half', () => {
        expect(splitSizes(unit({ size: 5 }))).toEqual([3, 2]);
        expect(splitSizes(unit({ size: 2 }))).toEqual([1, 1]);
    });

    it('strengthens up to the maximum', () => {
        expect(strengthenUnit(unit({ strength: 50 })).strength).toBe(50 + UNITS.strengthenAmount);
        expect(strengthenUnit(unit({ strength: UNITS.maxStrength - 1 })).strength).toBe(UNITS.maxStrength);
    });

    it('numbers new units per faction', () => {
        const c = { seed: 'x', units: [], nextId: 7, numbers: { 0: 3 } };
        const first = addUnit(c, { faction: 0, province: 0, size: 1, strength: 50, motivation: 0.5 });
        expect(first.unit).toMatchObject({ id: 7, name: '3rd Division' });
        expect(first.campaign).toMatchObject({ nextId: 8, numbers: { 0: 4 } });
    });
});

describe('actions', () => {
    const campaign = deployUnits(map);
    const own = campaign.units.find((u) => u.faction === player.id && u.province === player.capital);

    describe('move', () => {
        it('lists own passable neighbours with their terrain cost', () => {
            const targets = moveTargets(campaign, map, own.id);
            expect(targets.length).toBeGreaterThan(0);
            for (const { province, cost } of targets) {
                const p = map.provinces[province];
                expect(map.provinces[own.province].neighbours).toContain(province);
                expect(p.owner).toBe(player.id);
                expect(cost).toBe(ACTION_COSTS.move * TERRAINS[p.terrain].moveCost);
            }
        });

        it('moves a unit to an own neighbour and charges the terrain cost', () => {
            const to = moveTargets(campaign, map, own.id)[0].province;
            const v = validateAction(campaign, map, rich, { type: 'move', unitId: own.id, to });
            expect(v).toEqual({ ok: true, cost: moveCost(map.provinces[to]) });
            const after = applyAction(campaign, { type: 'move', unitId: own.id, to });
            expect(after.units.find((u) => u.id === own.id).province).toBe(to);
            expect(campaign.units.find((u) => u.id === own.id).province).toBe(own.province); // pure
        });

        it('refuses enemy, impassable and distant provinces', () => {
            const ownedProvinces = map.provinces.filter((p) => p.owner === player.id);
            const front = ownedProvinces.find((p) => p.neighbours.some((n) => map.provinces[n].owner !== player.id));
            const enemy = front.neighbours.find((n) => map.provinces[n].owner !== player.id);
            const atFront = { ...campaign, units: [...campaign.units, { ...own, id: 999, province: front.id }] };
            expect(validateAction(atFront, map, rich, { type: 'move', unitId: 999, to: enemy })).toMatchObject({ ok: false, reason: expect.stringMatching(/attacked/) });

            const sea = map.provinces.find((p) => p.terrain === 'sea');
            expect(validateAction(campaign, map, rich, { type: 'move', unitId: own.id, to: sea.id }).ok).toBe(false);

            const far = ownedProvinces.find((p) => p.id !== own.province && !map.provinces[own.province].neighbours.includes(p.id));
            expect(validateAction(campaign, map, rich, { type: 'move', unitId: own.id, to: far.id })).toMatchObject({ ok: false, reason: expect.stringMatching(/not next/) });
        });
    });

    it('refuses actions without enough AP, on missing units and on enemy units', () => {
        expect(validateAction(campaign, map, { faction: player.id, balance: 1 }, { type: 'strengthen', unitId: own.id })).toMatchObject({ ok: false, cost: ACTION_COSTS.strengthen });
        expect(validateAction(campaign, map, rich, { type: 'split', unitId: 12345 }).ok).toBe(false);
        const enemyUnit = campaign.units.find((u) => u.faction !== player.id);
        expect(validateAction(campaign, map, rich, { type: 'split', unitId: enemyUnit.id }).ok).toBe(false);
    });

    it('strengthens, and refuses a fully equipped unit', () => {
        const after = applyAction(campaign, { type: 'strengthen', unitId: own.id });
        expect(after.units.find((u) => u.id === own.id).strength).toBe(UNITS.start.strength + UNITS.strengthenAmount);
        const full = { ...campaign, units: campaign.units.map((u) => (u.id === own.id ? { ...u, strength: UNITS.maxStrength } : u)) };
        expect(validateAction(full, map, rich, { type: 'strengthen', unitId: own.id }).ok).toBe(false);
    });

    it('splits a unit in two, keeping strength, and refuses units too small', () => {
        const after = applyAction(campaign, { type: 'split', unitId: own.id });
        const here = unitsIn(after, own.province);
        expect(here.map((u) => u.size).sort()).toEqual([1, 2]);
        expect(here.every((u) => u.strength === own.strength)).toBe(true);
        expect(after.units).toHaveLength(campaign.units.length + 1);
        const small = here.find((u) => u.size === 1);
        expect(validateAction(after, map, rich, { type: 'split', unitId: small.id }).ok).toBe(false);
    });

    it('merges two units in the same province only', () => {
        const split = applyAction(campaign, { type: 'split', unitId: own.id });
        const [a, b] = unitsIn(split, own.province);
        expect(validateAction(split, map, rich, { type: 'merge', unitId: a.id, otherId: b.id })).toEqual({ ok: true, cost: ACTION_COSTS.merge });
        const merged = applyAction(split, { type: 'merge', unitId: a.id, otherId: b.id });
        expect(unitsIn(merged, own.province)).toHaveLength(1);
        expect(unitsIn(merged, own.province)[0].size).toBe(own.size);

        const elsewhere = campaign.units.find((u) => u.faction === player.id && u.id !== own.id);
        expect(validateAction(campaign, map, rich, { type: 'merge', unitId: own.id, otherId: elsewhere.id })).toMatchObject({ ok: false, reason: expect.stringMatching(/same province/) });
        const big = { ...campaign, units: [...campaign.units, { ...own, id: 500, size: UNITS.maxSize }] };
        expect(validateAction(big, map, rich, { type: 'merge', unitId: own.id, otherId: 500 }).ok).toBe(false);
    });
});

describe('daily moves', () => {
    const campaign = deployUnits(map);
    const own = campaign.units.find((u) => u.faction === player.id && u.province === player.capital);

    it('lets a unit move once a day', () => {
        const [first, second] = moveTargets(campaign, map, own.id);
        const moved = applyAction(campaign, { type: 'move', unitId: own.id, to: first.province });
        const after = moved.units.find((u) => u.id === own.id);
        expect(movesLeft(after)).toBe(UNITS.movesPerDay - 1);
        expect(moveTargets(moved, map, own.id)).toEqual([]);
        const back = map.provinces[first.province].neighbours.find((n) => map.provinces[n].owner === player.id) ?? second.province;
        expect(validateAction(moved, map, rich, { type: 'move', unitId: own.id, to: back })).toMatchObject({ ok: false, reason: expect.stringMatching(/already moved/) });
        // Other actions are still allowed
        expect(validateAction(moved, map, rich, { type: 'strengthen', unitId: own.id }).ok).toBe(true);
    });

    it('gives the moves back on a new day', () => {
        const to = moveTargets(campaign, map, own.id)[0].province;
        const moved = applyAction(campaign, { type: 'move', unitId: own.id, to });
        const rested = refreshMoves(moved);
        expect(movesLeft(rested.units.find((u) => u.id === own.id))).toBe(UNITS.movesPerDay);
        expect(moveTargets(rested, map, own.id).length).toBeGreaterThan(0);
        // Only the chosen units when a filter is given
        const enemyOnly = refreshMoves(moved, (u) => u.faction !== player.id);
        expect(movesLeft(enemyOnly.units.find((u) => u.id === own.id))).toBe(0);
    });

    it('keeps the moves already used when merging or splitting', () => {
        const to = moveTargets(campaign, map, own.id)[0].province;
        const moved = applyAction(campaign, { type: 'move', unitId: own.id, to });
        const split = applyAction(moved, { type: 'split', unitId: own.id });
        for (const u of unitsIn(split, to)) expect(movesLeft(u)).toBe(0);
        const fresh = { ...own, id: 777, province: to, movesUsed: 0 };
        const merged = mergeUnits(fresh, moved.units.find((u) => u.id === own.id));
        expect(movesLeft(merged)).toBe(0);
    });
});
