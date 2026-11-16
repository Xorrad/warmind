/**
 * @file Todo-list rules: task creation, validation, completion, streaks.
 *
 * Pure functions only: every function that depends on the current time
 * takes `now` as a parameter, and ids are supplied by the caller, so the
 * engine stays deterministic and testable.
 *
 * Two kinds of tasks:
 *  - one-off tasks have a due date and are completed once;
 *  - recurring tasks (streaks) are due every day; each day they are done
 *    is recorded, and the streak is the run of consecutive days.
 */

import { TASKS } from './config.js';

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {number} severity 1 to 5; weighs the daily points penalty.
 * @property {boolean} recurring True for daily (streak) tasks.
 * @property {string|null} dueAt ISO date-time; null for recurring tasks.
 * @property {string} createdAt ISO date-time.
 * @property {string|null} completedAt One-off tasks: when it was completed.
 * @property {string[]} doneOn Recurring tasks: local days (YYYY-MM-DD) it was done.
 *
 * @typedef {object} TaskFields
 * @property {string} title
 * @property {number} severity
 * @property {boolean} recurring
 * @property {string|null} [dueAt]
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Local calendar day of a date, as YYYY-MM-DD.
 * @param {Date} date
 * @returns {string}
 */
export function dayKey(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Day key shifted by a number of days.
 * @param {string} key YYYY-MM-DD
 * @param {number} days
 * @returns {string}
 */
export function shiftDay(key, days) {
    const [y, m, d] = key.split('-').map(Number);
    return dayKey(new Date(y, m - 1, d + days));
}

/**
 * Check task fields. Returns an object mapping each invalid field to a
 * message; empty when everything is valid.
 * @param {Partial<TaskFields>} fields
 * @returns {Record<string, string>}
 */
export function validateTask(fields) {
    const errors = {};
    const title = typeof fields.title === 'string' ? fields.title.trim() : '';
    if (!title) errors.title = 'Give the task a title.';
    else if (title.length > TASKS.titleMaxLength) errors.title = `Keep the title under ${TASKS.titleMaxLength} characters.`;
    const { min, max } = TASKS.severity;
    if (!Number.isInteger(fields.severity) || fields.severity < min || fields.severity > max) {
        errors.severity = `Severity goes from ${min} to ${max}.`;
    }
    if (!fields.recurring && (!fields.dueAt || Number.isNaN(Date.parse(fields.dueAt)))) {
        errors.dueAt = 'Set a due date.';
    }
    return errors;
}

/**
 * Create a task from validated fields.
 * @param {TaskFields} fields
 * @param {{ id: string, now: Date }} context
 * @returns {Task}
 */
export function createTask(fields, { id, now }) {
    const errors = validateTask(fields);
    if (Object.keys(errors).length) throw new Error(Object.values(errors).join(' '));
    return {
        id,
        title: fields.title.trim(),
        severity: fields.severity,
        recurring: Boolean(fields.recurring),
        dueAt: fields.recurring ? null : new Date(fields.dueAt).toISOString(),
        createdAt: now.toISOString(),
        completedAt: null,
        doneOn: [],
    };
}

/**
 * Apply edited fields to a task, keeping its id and completion history.
 * @param {Task} task
 * @param {TaskFields} fields
 * @returns {Task}
 */
export function updateTask(task, fields) {
    const errors = validateTask(fields);
    if (Object.keys(errors).length) throw new Error(Object.values(errors).join(' '));
    const recurring = Boolean(fields.recurring);
    return {
        ...task,
        title: fields.title.trim(),
        severity: fields.severity,
        recurring,
        dueAt: recurring ? null : new Date(fields.dueAt).toISOString(),
        // Switching kind resets the other kind's progress
        completedAt: recurring ? null : task.completedAt,
        doneOn: recurring ? task.doneOn : [],
    };
}

/**
 * Whether the task existed at `now`. Tasks are evaluated "as of" a moment
 * so past days can be settled with the task list as it was then.
 * @param {Task} task
 * @param {Date} now
 */
export function existsAt(task, now) {
    return Date.parse(task.createdAt) <= now.getTime();
}

/**
 * Whether a one-off task had been completed at `now`.
 * @param {Task} task
 * @param {Date} now
 */
export function isCompleted(task, now) {
    return !task.recurring && task.completedAt !== null && Date.parse(task.completedAt) <= now.getTime();
}

/**
 * Whether the task counts as done for the day of `now`.
 * @param {Task} task
 * @param {Date} now
 */
export function isDoneToday(task, now) {
    const today = dayKey(now);
    if (task.recurring) return task.doneOn.includes(today);
    return isCompleted(task, now) && dayKey(new Date(task.completedAt)) === today;
}

/**
 * Whether a one-off task is past its due date and still not completed.
 * Recurring tasks are never overdue: a missed day only breaks the streak.
 * @param {Task} task
 * @param {Date} now
 */
export function isOverdue(task, now) {
    return !task.recurring && !isCompleted(task, now) && Date.parse(task.dueAt) < now.getTime();
}

/**
 * Days left before a one-off task is due (fractional, negative if overdue).
 * @param {Task} task
 * @param {Date} now
 */
export function daysLeft(task, now) {
    return (Date.parse(task.dueAt) - now.getTime()) / DAY_MS;
}

/**
 * Current streak of a recurring task: consecutive days done, ending today
 * (or yesterday, since today is not over yet).
 * @param {Task} task
 * @param {Date} now
 * @returns {number}
 */
export function streakOf(task, now) {
    if (!task.recurring) return 0;
    const done = new Set(task.doneOn);
    let day = dayKey(now);
    if (!done.has(day)) day = shiftDay(day, -1);
    let streak = 0;
    while (done.has(day)) {
        streak++;
        day = shiftDay(day, -1);
    }
    return streak;
}

/**
 * Mark a task done for today, or undo it.
 * @param {Task} task
 * @param {Date} now
 * @returns {Task}
 */
export function toggleDone(task, now) {
    if (task.recurring) {
        const today = dayKey(now);
        const doneOn = task.doneOn.includes(today)
            ? task.doneOn.filter((d) => d !== today)
            : [...task.doneOn, today].sort().slice(-TASKS.historyDays);
        return { ...task, doneOn };
    }
    return { ...task, completedAt: task.completedAt === null ? now.toISOString() : null };
}

/**
 * Split tasks into the three side panels, each sorted for display:
 *  - todo: unfinished one-off tasks, by due date (overdue ones come first),
 *    then those completed today (they move on the next day);
 *  - streaks: every recurring task, those still to do today first;
 *  - completed: one-off tasks completed before today, most recent first.
 * @param {Task[]} tasks
 * @param {Date} now
 * @returns {{ todo: Task[], streaks: Task[], completed: Task[] }}
 */
export function partitionTasks(tasks, now) {
    const byTitle = (a, b) => a.title.localeCompare(b.title);
    // One-off tasks checked today stay in the todo list (below the open
    // ones) until the next day, so a misclick is easy to undo
    const doneFirst = (a, b) => Number(isDoneToday(a, now)) - Number(isDoneToday(b, now));
    const todo = tasks
        .filter((t) => !t.recurring && (t.completedAt === null || isDoneToday(t, now)))
        .sort((a, b) => doneFirst(a, b) || Date.parse(a.dueAt) - Date.parse(b.dueAt) || byTitle(a, b));
    const streaks = tasks.filter((t) => t.recurring).sort((a, b) => doneFirst(a, b) || byTitle(a, b));
    const completed = tasks
        .filter((t) => !t.recurring && isCompleted(t, now) && !isDoneToday(t, now))
        .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || byTitle(a, b));
    return { todo, streaks, completed };
}
