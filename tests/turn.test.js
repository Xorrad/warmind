import { describe, it, expect } from 'vitest';
import { settleGame } from '../engine/turn.js';
import { generateMap } from '../engine/mapgen.js';
import { deployUnits } from '../engine/units.js';
import { POINTS } from '../engine/config.js';

const map = generateMap({ seed: 'turn' });
const campaign = deployUnits(map);
const now = new Date(2026, 10, 15, 10, 0);

describe('settleGame', () => {
    it('does nothing without a campaign', () => {
        const state = { tasks: [], ledger: { balance: 0, settledThrough: null }, campaign: null };
        expect(settleGame(state, { now })).toEqual({ state, settlement: null });
    });

    it('starts the count of a new game without back-pay', () => {
        const { state, settlement } = settleGame({ tasks: [], ledger: { balance: 5, settledThrough: null }, campaign }, { now, map });
        expect(settlement).toBeNull();
        expect(state.ledger).toEqual({ balance: 5, settledThrough: '2026-11-14' });
        expect(state.campaign).toBe(campaign);
    });

    it('credits each ended day, plays the enemies and gives moves back', () => {
        const tired = { ...campaign, units: campaign.units.map((u) => ({ ...u, movesUsed: 1 })) };
        const { state, settlement } = settleGame(
            { tasks: [], ledger: { balance: 0, settledThrough: '2026-11-12' }, campaign: tired },
            { now, map },
        );
        expect(settlement.granted.map((g) => g.day)).toEqual(['2026-11-13', '2026-11-14']);
        const owned = map.provinces.filter((p) => p.owner === map.factions.find((f) => f.isPlayer).id).length;
        expect(settlement.granted[0].points).toBe(Math.round(POINTS.base + POINTS.perProvince * owned));
        expect(state.ledger.settledThrough).toBe('2026-11-14');
        expect(state.campaign.battles).toBeGreaterThan(campaign.battles);
        expect(state.campaign.units.every((u) => !u.movesUsed)).toBe(true);
        for (const r of settlement.reports) expect(['2026-11-13', '2026-11-14']).toContain(r.day);
    });

    it('is a no-op the second time on the same day, and deterministic', () => {
        const start = { tasks: [], ledger: { balance: 0, settledThrough: '2026-11-12' }, campaign };
        const once = settleGame(start, { now, map });
        expect(settleGame(start, { now })).toEqual(once);
        const again = settleGame(once.state, { now, map });
        expect(again.settlement).toBeNull();
        expect(again.state).toBe(once.state);
    });
});
