/**
 * @file Daily action points computed from the task list.
 *
 * See POINTS in config.js for the formula. This module only computes the
 * amount; granting it happens in the daily tick.
 */

import { POINTS } from './config.js';
import { daysLeft, existsAt, isCompleted, isDoneToday, isOverdue } from './tasks.js';

/**
 * @typedef {object} PointsBreakdown
 * @property {number} base Points from the faction size.
 * @property {{ taskId: string, amount: number }[]} penalties One per unfinished task.
 * @property {number} penalty Sum of the penalties.
 * @property {number} bonus Bonus for tasks completed today.
 * @property {string[]} overdue Ids of overdue tasks (any one zeroes the total).
 * @property {number} total Points granted, a non-negative integer.
 */

/**
 * Urgency of a task due in `days` days: 1 when due now, falling linearly to
 * minUrgency at urgencyWindowDays and beyond.
 * @param {number} days
 */
export function urgency(days) {
    return Math.min(1, Math.max(POINTS.minUrgency, 1 - days / POINTS.urgencyWindowDays));
}

/**
 * Points a faction would receive for the day of `now`, given its tasks as
 * they stood at `now` (tasks created later, or completed later, are seen as
 * absent or unfinished). Recurring tasks not yet done that day count as due
 * that day (full urgency).
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
        if (task.recurring) {
            penalties.push({ taskId: task.id, amount: task.severity });
        } else if (!isCompleted(task, now)) {
            if (isOverdue(task, now)) overdue.push(task.id);
            penalties.push({ taskId: task.id, amount: task.severity * urgency(daysLeft(task, now)) });
        }
    }

    const penalty = penalties.reduce((sum, p) => sum + p.amount, 0);
    const bonus = Math.min(completed * POINTS.completionBonus, POINTS.completionBonusCap);
    const total = overdue.length ? 0 : Math.max(0, Math.round(base - penalty + bonus));
    return { base, penalties, penalty, bonus, overdue, total };
}
