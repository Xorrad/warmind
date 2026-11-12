/**
 * @file Daily action points computed from the task list.
 *
 * See POINTS in config.js for the formula. This module only computes the
 * amount; granting it happens in the daily tick.
 */

import { POINTS } from './config.js';
import { existsAt, isCompleted, isDoneToday, isOverdue } from './tasks.js';

/**
 * @typedef {object} PointsBreakdown
 * @property {number} base Points from the faction size.
 * @property {{ taskId: string, amount: number }[]} penalties One per unfinished
 *   task, after the cap.
 * @property {number} penalty Sum of the penalties (at most maxPenaltyShare × base).
 * @property {number} rawPenalty Sum before the cap.
 * @property {boolean} capped Whether the cap scaled the penalties down.
 * @property {number} bonus Bonus for tasks completed today.
 * @property {string[]} overdue Ids of overdue tasks (any one zeroes the total).
 * @property {number} total Points granted, a non-negative integer.
 */

/**
 * Share of its time a task has used up at `now`: 0 when just created, 1 at
 * its due date (and after). A daily task runs from the start to the end of
 * the day of `now`.
 * @param {import('./tasks.js').Task} task
 * @param {Date} now
 * @returns {number} Between 0 and 1.
 */
export function elapsedShare(task, now) {
    let start;
    let end;
    if (task.recurring) {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1;
    } else {
        start = Date.parse(task.createdAt);
        end = Date.parse(task.dueAt);
    }
    if (end <= start) return 1;
    return Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
}

/**
 * Points a faction would receive for the day of `now`, given its tasks as
 * they stood at `now` (tasks created later, or completed later, are seen as
 * absent or unfinished).
 * @param {import('./tasks.js').Task[]} tasks
 * @param {{ provincesOwned: number, now: Date }} context
 * @returns {PointsBreakdown}
 */
export function computeDailyPoints(tasks, { provincesOwned, now }) {
    const base = POINTS.base + POINTS.perProvince * provincesOwned;
    const penalties = [];
    const overdue = [];
    let completed = 0;

    for (const task of tasks) {
        if (!existsAt(task, now)) continue;
        if (isDoneToday(task, now)) {
            completed++;
            continue;
        }
        if (task.recurring || !isCompleted(task, now)) {
            if (isOverdue(task, now)) overdue.push(task.id);
            penalties.push({ taskId: task.id, amount: task.severity * elapsedShare(task, now) });
        }
    }

    // Cap the losses, shared out in proportion to each task's own loss
    const rawPenalty = penalties.reduce((sum, p) => sum + p.amount, 0);
    const maxPenalty = POINTS.maxPenaltyShare * base;
    const capped = rawPenalty > maxPenalty;
    if (capped) for (const p of penalties) p.amount *= maxPenalty / rawPenalty;
    const penalty = capped ? maxPenalty : rawPenalty;

    const bonus = Math.min(completed * POINTS.completionBonus, POINTS.completionBonusCap);
    const total = overdue.length ? 0 : Math.max(0, Math.round(base - penalty + bonus));
    return { base, penalties, penalty, rawPenalty, capped, bonus, overdue, total };
}
