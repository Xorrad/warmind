/**
 * @file Todo / Streaks / Completed side panels.
 */

import { TASKS } from '/engine/config.js';
import { partitionTasks, isOverdue, isDoneToday, streakOf, daysLeft } from '/engine/tasks.js';
import { h } from './dom.js';
import { playCrossOut, playUncross } from './sound.js';

/** How long the pencil takes to cross a task out; the task moves after. */
export const STRIKE_MS = 1000;

/**
 * Tasks being crossed out: id → timer that commits the toggle. They are
 * drawn as done in the meantime, even if the lists are re-rendered.
 * @type {Map<string, ReturnType<typeof setTimeout>>}
 */
const striking = new Map();
/** The commit of each pending toggle (to flush them when leaving the page). */
const commits = new Map();

// Leaving the page during an animation: save the checks anyway
addEventListener('pagehide', () => {
    for (const [id, timer] of striking) {
        clearTimeout(timer);
        commits.get(id)?.();
    }
    striking.clear();
    commits.clear();
});

/**
 * The checkbox of a task: crossing out plays a pen stroke and waits for the
 * line to be drawn before the task moves (onToggle); unchecking is
 * immediate. Clicking again during the animation cancels it.
 */
function onCheck(event, task, done, onToggle) {
    const li = event.target.closest('.task');
    if (striking.has(task.id)) {
        clearTimeout(striking.get(task.id));
        striking.delete(task.id);
        commits.delete(task.id);
        li.classList.remove('done', 'striking');
        playUncross();
        return;
    }
    if (done) {
        playUncross();
        onToggle(task.id);
        return;
    }
    playCrossOut();
    li.classList.add('striking');
    // Next frame, so the line grows from nothing
    requestAnimationFrame(() => li.classList.add('done'));
    const commit = () => onToggle(task.id);
    commits.set(task.id, commit);
    striking.set(
        task.id,
        setTimeout(() => {
            striking.delete(task.id);
            commits.delete(task.id);
            commit();
        }, STRIKE_MS),
    );
}

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
 * @param {Map<string, number>} gains Points each open task would add if completed now.
 * @param {TaskCallbacks} callbacks
 */
export function renderTasks(panels, tasks, now, gains, callbacks) {
    const { todo, streaks, completed } = partitionTasks(tasks, now);
    const ctx = { now, gains, callbacks };
    fill(panels.todo, todo, ctx, 'Nothing left to do. Add a task to earn points.');
    fill(panels.streaks, streaks, ctx, 'No daily task yet. Add habits you want to keep every day.');
    fillPaged(panels.completed, completed, ctx, 'Nothing completed yet.');
    const counts = {
        todo: todo.filter((t) => !isDoneToday(t, now)).length,
        streaks: streaks.filter((t) => !isDoneToday(t, now)).length,
        completed: completed.length,
    };
    for (const [name, n] of Object.entries(counts)) {
        const count = document.querySelector(`[data-count="${name}"]`);
        if (count) count.textContent = String(n);
    }
}

function fill(container, tasks, ctx, emptyText) {
    container.replaceChildren(...(tasks.length ? tasks.map((t) => taskItem(t, ctx)) : [h('li', { class: 'task-empty' }, emptyText)]));
}

/** Completed tasks rendered per page; more are added when scrolling near the end. */
const PAGE_SIZE = 20;
const paging = new WeakMap();

/**
 * Like fill(), but only renders the first rows and appends the next page
 * whenever a sentinel at the end of the list scrolls into view. The number
 * of rows already shown survives re-renders, so the list does not jump back.
 */
function fillPaged(container, tasks, ctx, emptyText) {
    let state = paging.get(container);
    if (!state) {
        state = {
            shown: PAGE_SIZE,
            tasks: [],
            ctx: null,
            observer: null,
            sentinel: h('li', { class: 'task-sentinel', 'aria-hidden': 'true' }),
        };
        // Implicit root: works whether the list or the whole sidebar (mobile) scrolls
        state.observer = new IntersectionObserver(
            (entries) => {
                if (!entries.some((e) => e.isIntersecting) || state.shown >= state.tasks.length) return;
                const next = state.tasks.slice(state.shown, state.shown + PAGE_SIZE);
                state.shown += next.length;
                state.sentinel.before(...next.map((t) => taskItem(t, state.ctx)));
                if (state.shown >= state.tasks.length) state.sentinel.remove();
            },
            { rootMargin: '0px 0px 200px 0px' },
        );
        state.observer.observe(state.sentinel);
        paging.set(container, state);
    }
    state.tasks = tasks;
    state.ctx = ctx;
    if (!tasks.length) {
        container.replaceChildren(h('li', { class: 'task-empty' }, emptyText));
        return;
    }
    const rows = tasks.slice(0, state.shown).map((t) => taskItem(t, ctx));
    container.replaceChildren(...rows, ...(state.shown < tasks.length ? [state.sentinel] : []));
}

function taskItem(task, { now, gains, callbacks: { onToggle, onEdit, onDelete } }) {
    const overdue = isOverdue(task, now);
    const done = (task.recurring ? isDoneToday(task, now) : task.completedAt !== null) || striking.has(task.id);
    const dueToday = !task.recurring && !done && !overdue && new Date(task.dueAt).toDateString() === now.toDateString();
    return h(
        'li',
        { class: `task${overdue ? ' overdue' : ''}${dueToday ? ' due-today' : ''}${done ? ' done' : ''}${task.recurring ? ' daily' : ''}` },
        h('input', {
            type: 'checkbox',
            class: 'task-check',
            checked: done,
            'aria-label': done ? `Mark "${task.title}" as not done` : `Mark "${task.title}" as done`,
            onchange: (e) => onCheck(e, task, done && !striking.has(task.id), onToggle),
        }),
        h(
            'button',
            { type: 'button', class: 'task-body', title: 'Edit task', onclick: () => onEdit(task.id) },
            h('span', { class: 'task-title' }, h('span', { class: 'strike' }, task.title)),
            h('span', { class: 'task-meta' }, ...meta(task, now, overdue)),
        ),
        gains.has(task.id) && gainBadge(gains.get(task.id), overdue),
        task.recurring && streakBadge(task, now, done),
        h(
            'button',
            {
                type: 'button',
                class: 'task-delete',
                'aria-label': `Delete "${task.title}"`,
                title: 'Delete',
                onclick: () => onDelete(task.id),
            },
            '×',
        ),
    );
}

function meta(task, now, overdue) {
    const parts = [];
    if (task.recurring) {
        parts.push(h('span', { class: 'tag' }, isDoneToday(task, now) ? 'Done today' : 'Every day'));
    } else if (task.completedAt !== null) {
        const at = new Date(task.completedAt);
        const late = at.getTime() > Date.parse(task.dueAt);
        parts.push(
            h('time', { class: 'tag', datetime: task.completedAt, title: at.toLocaleString() }, `Completed ${formatRelative(at, now)}`),
            late && h('span', { class: 'tag late' }, 'late'),
        );
    } else {
        parts.push(
            h('span', { class: `tag due${overdue ? ' late' : ''}` }, overdue ? `Overdue · ${formatDue(task, now)}` : formatDue(task, now)),
        );
    }
    parts.push(
        h(
            'span',
            { class: 'severity', title: `Severity ${task.severity} of ${TASKS.severity.max}` },
            '●'.repeat(task.severity) + '○'.repeat(TASKS.severity.max - task.severity),
        ),
    );
    return parts;
}

/**
 * Streak counter of a daily task. When today is not done yet the streak is
 * still alive but at risk, which is shown with a dimmed badge.
 */
function streakBadge(task, now, done) {
    const streak = streakOf(task, now);
    const state = done ? 'kept' : streak ? 'at-risk' : 'none';
    const label = done ? `${streak}-day streak` : streak ? `${streak}-day streak, do it today to keep it` : 'No streak yet';
    return h(
        'span',
        { class: `streak-badge ${state}`, title: label, 'aria-label': label },
        h('span', { 'aria-hidden': 'true' }, '🔥'),
        String(streak),
    );
}

/**
 * Points the task is worth: how much completing it now raises tomorrow's
 * gain. An overdue task can be worth the whole day.
 */
function gainBadge(gain, overdue) {
    const title = gain
        ? `Completing it now adds ${gain} AP to tomorrow's gain${overdue ? ' (it stops blocking the whole day)' : ''}`
        : 'Completing it now adds nothing to tomorrow (another task is overdue, or the effect rounds to 0)';
    return h('span', { class: `gain-badge${gain ? '' : ' zero'}`, title }, `+${gain} AP`);
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", "2 months ago"… */
function formatRelative(date, now) {
    const seconds = (now.getTime() - date.getTime()) / 1000;
    if (seconds < 45) return 'just now';
    if (seconds < 3600) return relative.format(-Math.round(seconds / 60), 'minute');
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(now) - startOf(date)) / 86400000);
    if (days === 0) return relative.format(-Math.round(seconds / 3600), 'hour');
    if (days < 7) return relative.format(-days, 'day');
    if (days < 30) return relative.format(-Math.round(days / 7), 'week');
    if (days < 365) return relative.format(-Math.round(days / 30), 'month');
    return relative.format(-Math.round(days / 365), 'year');
}

const PANELS_KEY = 'warmind.panels.v1';

/**
 * Wire the collapse and maximize buttons of each panel header. A maximized
 * panel fills the sidebar and the others shrink to their headers. Which
 * panels are collapsed is remembered in this browser; maximizing is not.
 * @param {HTMLElement} sidebar
 */
export function setupPanelToggles(sidebar) {
    let collapsed = {};
    try {
        collapsed = JSON.parse(localStorage.getItem(PANELS_KEY)) ?? {};
    } catch {
        // Storage unavailable: everything starts expanded
    }
    const save = () => {
        try {
            localStorage.setItem(PANELS_KEY, JSON.stringify(collapsed));
        } catch {
            // Not remembered, still works
        }
    };
    const panels = [...sidebar.querySelectorAll('.panel')];
    const label = (panel) => panel.querySelector('h2').firstChild.textContent.trim();

    /** Reflect the collapsed / maximized state on the panels and their buttons. */
    const sync = () => {
        const maximized = panels.find((p) => p.classList.contains('maximized'));
        sidebar.classList.toggle('has-maximized', Boolean(maximized));
        for (const panel of panels) {
            const name = panel.querySelector('[data-panel-collapse]').dataset.panelCollapse;
            panel.classList.toggle('collapsed', Boolean(collapsed[name]));
            const open = maximized ? panel === maximized : !collapsed[name];
            const collapse = panel.querySelector('[data-panel-collapse]');
            collapse.setAttribute('aria-expanded', String(open));
            collapse.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${label(panel)}`);
            collapse.title = open ? 'Collapse' : 'Expand';
            const max = panel.querySelector('[data-panel-maximize]');
            const isMax = panel === maximized;
            max.setAttribute('aria-pressed', String(isMax));
            max.setAttribute('aria-label', `${isMax ? 'Restore' : 'Maximize'} ${label(panel)}`);
            max.title = isMax ? 'Restore' : 'Maximize';
        }
    };

    for (const panel of panels) {
        const name = panel.querySelector('[data-panel-collapse]').dataset.panelCollapse;
        panel.querySelector('[data-panel-collapse]').addEventListener('click', () => {
            const maximized = panels.find((p) => p.classList.contains('maximized'));
            if (maximized) {
                // Leave the maximized layout; a shrunk panel comes back opened
                maximized.classList.remove('maximized');
                if (panel !== maximized) collapsed[name] = false;
                else collapsed[name] = true;
            } else {
                collapsed[name] = !collapsed[name];
            }
            save();
            sync();
        });
        panel.querySelector('[data-panel-maximize]').addEventListener('click', () => {
            const isMax = panel.classList.contains('maximized');
            for (const p of panels) p.classList.toggle('maximized', !isMax && p === panel);
            sync();
        });
    }
    sync();
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
