/**
 * @file The whole daily turn, for the server (and test sessions in the
 * browser): for every day that ended since the last settlement, credit the
 * player's points, let the enemy factions play, then start the new day
 * (every unit gets its move back).
 *
 * Day boundaries follow the local time of the JavaScript runtime: the
 * server runs this in the player's time zone (see server/timezone.js).
 */

import { generateMap } from './mapgen.js';
import { ownedMap, refreshMoves } from './units.js';
import { playDays } from './ai.js';
import { settleDays } from './tick.js';

/**
 * @typedef {object} GameState
 * @property {import('./tasks.js').Task[]} tasks
 * @property {import('./tick.js').Ledger} ledger
 * @property {import('./units.js').Campaign|null} campaign
 *
 * @typedef {object} Settlement What a settlement brought, for the report.
 * @property {{ day: string, points: number }[]} granted
 * @property {object[]} reports Battle reports of the enemy turns (with `day`).
 */

/**
 * Settle every day that ended before `now`.
 * @param {GameState} state
 * @param {{ now: Date, map?: import('./mapgen.js').GameMap }} context `map` is the
 *   generated map of the campaign's seed, when the caller already has it.
 * @returns {{ state: GameState, settlement: Settlement|null }} settlement is null
 *   when no day ended (the state may still change: a new game starts its count).
 */
export function settleGame(state, { now, map }) {
    const { tasks, ledger, campaign } = state;
    if (!campaign) return { state, settlement: null };
    const baseMap = map ?? generateMap({ seed: campaign.seed });
    const shown = ownedMap(baseMap, campaign);
    const player = shown.factions.find((f) => f.isPlayer);
    const provincesOwned = shown.provinces.filter((p) => p.owner === player.id).length;

    const result = settleDays(ledger, tasks, { provincesOwned, now });
    if (!result.granted.length) {
        // Unchanged state when nothing moved, so callers can skip saving
        const unchanged = result.ledger.settledThrough === ledger.settledThrough;
        return { state: unchanged ? state : { ...state, ledger: result.ledger }, settlement: null };
    }

    const enemy = playDays(
        campaign,
        baseMap,
        result.granted.map((g) => g.day),
    );
    return {
        state: { tasks, ledger: result.ledger, campaign: refreshMoves(enemy.campaign) },
        settlement: { granted: result.granted, reports: enemy.reports },
    };
}
