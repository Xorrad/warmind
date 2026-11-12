import { describe, it, expect } from 'vitest';
import { generateMap } from '../engine/mapgen.js';
import { deployUnits, ownerOf } from '../engine/units.js';
import { playFaction, playDay, playDays, aiIncome } from '../engine/ai.js';
import { AI, POINTS, TERRAINS } from '../engine/config.js';

const map = generateMap({ seed: 'demo' });
const player = map.factions.find((f) => f.isPlayer);
const passable = (id) => TERRAINS[map.provinces[id].terrain].passable;
/** An enemy faction that borders the player. */
const enemy = map.factions.find(
    (f) =>
        !f.isPlayer &&
        map.provinces.some(
            (p) => p.owner === f.id && passable(p.id) && p.neighbours.some((n) => map.provinces[n].owner === player.id && passable(n)),
        ),
);
const base = deployUnits(map);

/** A campaign holding only the given units, with an AI budget. */
const only = (units, ap = 100) => ({ ...base, units, ai: { [enemy.id]: ap } });

/** An enemy province bordering one of the player's provinces. */
function border() {
    for (const p of map.provinces) {
        if (p.owner !== enemy.id || !TERRAINS[p.terrain].passable) continue;
        const target = p.neighbours.find((n) => map.provinces[n].owner === player.id && TERRAINS[map.provinces[n].terrain].passable);
        if (target !== undefined) return { from: p.id, target };
    }
    throw new Error('no border');
}

const unit = (fields) => ({ id: 1, name: 'Unit', faction: enemy.id, province: 0, size: 2, strength: 70, motivation: 0.5, ...fields });

describe('aiIncome', () => {
    it('follows the player formula for its province count', () => {
        const owned = map.provinces.filter((p) => p.owner === enemy.id).length;
        expect(aiIncome(base, map, enemy.id)).toBe(Math.round((POINTS.base + POINTS.perProvince * owned) * AI.incomeFactor));
    });
});

describe('playFaction', () => {
    it('attacks when the odds are good and takes the province', () => {
        const { from, target } = border();
        // Every other neighbour belongs to the AI: the player province is the only target
        const owners = [...base.owners];
        for (const n of map.provinces[from].neighbours) if (n !== target && owners[n] >= 0) owners[n] = enemy.id;
        const c = {
            ...only([
                unit({ id: 1, province: from, size: 8, strength: 100, motivation: 1 }),
                unit({ id: 2, faction: player.id, province: target, size: 1, strength: 40 }),
            ]),
            owners,
        };
        const { campaign, actions } = playFaction(c, map, enemy.id);
        expect(actions[0]).toMatchObject({ type: 'attack', to: target, unitIds: [1] });
        expect(ownerOf(campaign, map, target)).toBe(enemy.id);
    });

    it('does not attack against bad odds', () => {
        const { from, target } = border();
        // Keep the unit on the front with a strong player unit opposite: no move, no attack
        const c = only([
            unit({ id: 1, province: from, size: 1, strength: 80 }),
            unit({ id: 2, faction: player.id, province: target, size: 10, strength: 100, motivation: 1 }),
        ]);
        const { actions } = playFaction(c, map, enemy.id);
        expect(actions.some((a) => a.type === 'attack' && a.to === target)).toBe(false);
    });

    it('resupplies a weak front unit when it cannot attack', () => {
        const { from, target } = border();
        const c = only(
            [
                unit({ id: 1, province: from, size: 1, strength: 20 }),
                unit({ id: 2, faction: player.id, province: target, size: 10, strength: 100, motivation: 1 }),
            ],
            2,
        );
        const { campaign, actions } = playFaction(c, map, enemy.id);
        expect(actions).toEqual([{ type: 'strengthen', unitId: 1 }]);
        expect(campaign.units.find((u) => u.id === 1).strength).toBeGreaterThan(20);
        expect(campaign.ai[enemy.id]).toBe(0);
    });

    it('moves an interior unit one step towards the front', () => {
        const front = (id) =>
            map.provinces[id].neighbours.some((n) => TERRAINS[map.provinces[n].terrain].passable && map.provinces[n].owner !== enemy.id);
        const inner = map.provinces.find((p) => p.owner === enemy.id && TERRAINS[p.terrain].passable && !front(p.id));
        const c = only([unit({ id: 1, province: inner.id })], 1);
        const { campaign, actions } = playFaction(c, map, enemy.id);
        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({ type: 'move', unitId: 1 });
        expect(inner.neighbours).toContain(campaign.units[0].province);
    });

    it('never spends more than its budget', () => {
        for (const ap of [0, 1, 3, 7]) {
            const { campaign } = playFaction({ ...base, ai: { [enemy.id]: ap } }, map, enemy.id);
            expect(campaign.ai[enemy.id]).toBeGreaterThanOrEqual(0);
            expect(campaign.ai[enemy.id]).toBeLessThanOrEqual(ap);
        }
    });
});

describe('playDay', () => {
    it('plays every enemy faction, not the player, and reports its battles', () => {
        const { campaign, reports } = playDay(base, map, '2026-11-12');
        for (const f of map.factions) {
            if (f.isPlayer) expect(campaign.ai?.[f.id]).toBeUndefined();
            else expect(campaign.ai[f.id]).toBeGreaterThanOrEqual(0);
        }
        expect(reports.length).toBe(campaign.battles - (base.battles ?? 0));
        for (const r of reports) {
            expect(r.day).toBe('2026-11-12');
            expect(r.attackerFaction).not.toBe(player.id);
        }
        // Player units are only ever moved by battles, never ordered
        const before = new Map(base.units.filter((u) => u.faction === player.id).map((u) => [u.id, u]));
        for (const u of campaign.units.filter((x) => x.faction === player.id)) {
            const was = before.get(u.id);
            if (u.province !== was.province)
                expect(reports.some((r) => r.defenders.some((d) => d.id === u.id && d.retreatedTo === u.province))).toBe(true);
        }
    });

    it('caps savings and is deterministic', () => {
        const days = ['2026-11-10', '2026-11-11', '2026-11-12'];
        const a = playDays(base, map, days);
        expect(playDays(base, map, days)).toEqual(a);
        for (const f of map.factions.filter((x) => !x.isPlayer)) {
            expect(a.campaign.ai[f.id]).toBeLessThanOrEqual(aiIncome(a.campaign, map, f.id) * AI.maxSavingsDays + 1);
        }
    });

    it('skips factions without land', () => {
        const owners = base.owners.map((o) => (o === enemy.id ? player.id : o));
        const units = base.units.filter((u) => u.faction !== enemy.id);
        const { campaign } = playDay({ ...base, owners, units }, map, '2026-11-12');
        expect(campaign.ai?.[enemy.id]).toBeUndefined();
    });
});

describe('AI and daily moves', () => {
    it('moves each unit at most once per day, and again the next day', () => {
        const day1 = playDay(base, map, '2026-11-10').campaign;
        for (const u of day1.units.filter((x) => x.faction !== player.id)) expect(u.movesUsed ?? 0).toBeLessThanOrEqual(1);
        const day2 = playDay(day1, map, '2026-11-11');
        // Units that moved on day 1 can act again on day 2
        const movedTwice = day2.campaign.units.filter((u) => u.faction !== player.id && (u.movesUsed ?? 0) > 0);
        expect(movedTwice.length).toBeGreaterThan(0);
        for (const u of day2.campaign.units) expect(u.movesUsed ?? 0).toBeLessThanOrEqual(1);
    });
});
