/**
 * @file Todo / Streaks / Completed side panels.
 */

import { TASKS } from '/engine/config.js';
import { partitionTasks, isOverdue, isDoneToday, streakOf, daysLeft } from '/engine/tasks.js';
import { h } from './dom.js';

/**
 * @typedef {object} TaskCallbacks
 * @property {(kind: 'once'|'daily') => void} onAdd
 * @property {(id: string) => void} onToggle
 * @property {(id: string) => void} onEdit
 * @property {(id: string) => void} onDelete
 */

/**
 * Render the three panels into their containers.
 * @param {{ todo: HTMLElement, streaks: HTMLElement, completed: HTMLElement }} panels
 * @param {import('/engine/tasks.js').Task[]} tasks
 * @param {Date} now
 * @param {TaskCallbacks} callbacks
 */
export function renderTasks(panels, tasks, now, callbacks) {
    const { todo, streaks, completed } = partitionTasks(tasks, now);
    fill(panels.todo, todo, now, callbacks, 'Nothing left to do. Add a task to earn points.');
    fill(panels.streaks, streaks, now, callbacks, 'No daily task yet. Add habits you want to keep every day.');
    fill(panels.completed, completed, now, callbacks, 'Nothing completed yet today.');
    const counts = { todo: todo.length, streaks: streaks.filter((t) => !isDoneToday(t, now)).length, completed: completed.length };
    for (const [name, n] of Object.entries(counts)) {
        const count = document.querySelector(`[data-count="${name}"]`);
        if (count) count.textContent = String(n);
    }
}

function fill(container, tasks, now, callbacks, emptyText) {
    container.replaceChildren(
        ...(tasks.length ? tasks.map((t) => taskItem(t, now, callbacks)) : [h('li', { class: 'task-empty' }, emptyText)]),
    );
}

function taskItem(task, now, { onToggle, onEdit, onDelete }) {
    const overdue = isOverdue(task, now);
    const done = isDoneToday(task, now);
    return h(
        'li',
        { class: `task${overdue ? ' overdue' : ''}${done ? ' done' : ''}${task.recurring ? ' daily' : ''}` },
        h('input', {
            type: 'checkbox',
            class: 'task-check',
            checked: done,
            'aria-label': done ? `Mark "${task.title}" as not done` : `Mark "${task.title}" as done`,
            onchange: () => onToggle(task.id),
        }),
        h(
            'button',
            { type: 'button', class: 'task-body', title: 'Edit task', onclick: () => onEdit(task.id) },
            h('span', { class: 'task-title' }, task.title),
            h('span', { class: 'task-meta' }, ...meta(task, now, overdue)),
        ),
        task.recurring && streakBadge(task, now, done),
        h('button', { type: 'button', class: 'task-delete', 'aria-label': `Delete "${task.title}"`, title: 'Delete', onclick: () => onDelete(task.id) }, '×'),
    );
}

function meta(task, now, overdue) {
    const parts = [];
    if (task.recurring) {
        parts.push(h('span', { class: 'tag' }, isDoneToday(task, now) ? 'Done today' : 'Every day'));
    } else {
        parts.push(h('span', { class: `tag due${overdue ? ' late' : ''}` }, overdue ? `Overdue · ${formatDue(task, now)}` : formatDue(task, now)));
    }
    parts.push(h('span', { class: 'severity', title: `Severity ${task.severity} of ${TASKS.severity.max}` }, '●'.repeat(task.severity) + '○'.repeat(TASKS.severity.max - task.severity)));
    return parts;
}

/**
 * Streak counter of a daily task. When today is not done yet the streak is
 * still alive but at risk, which is shown with a dimmed badge.
 */
function streakBadge(task, now, done) {
    const streak = streakOf(task, now);
    const state = done ? 'kept' : streak ? 'at-risk' : 'none';
    const label = done
        ? `${streak}-day streak`
        : streak
          ? `${streak}-day streak, do it today to keep it`
          : 'No streak yet';
    return h('span', { class: `streak-badge ${state}`, title: label, 'aria-label': label }, h('span', { 'aria-hidden': 'true' }, '🔥'), String(streak));
}

/** "today 18:00", "tomorrow 09:00", "in 3 days", "Fri 14 Nov"… */
function formatDue(task, now) {
    const due = new Date(task.dueAt);
    const time = due.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayDiff = Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate()) - startOfToday) / 86400000);
    if (dayDiff === 0) return `today ${time}`;
    if (dayDiff === 1) return `tomorrow ${time}`;
    if (dayDiff === -1) return `yesterday ${time}`;
    if (dayDiff > 1 && daysLeft(task, now) < 7) return `in ${dayDiff} days`;
    return due.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}
