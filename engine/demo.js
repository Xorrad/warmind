/**
 * @file Generated sample data for manual testing (the "demo" session).
 *
 * Produces a realistic, sizeable task list: open tasks spread from overdue
 * to months ahead, daily tasks in every streak state, and a long history of
 * completed tasks. Dates are relative to `now`; everything else depends
 * only on the seed, so the same seed gives the same data set.
 */

import { createRng } from './rng.js';
import { createTask, dayKey, shiftDay } from './tasks.js';

const DAY = 24 * 60 * 60 * 1000;

const ACTIONS = ['Finish', 'Review', 'Submit', 'Read', 'Write', 'Prepare', 'Revise', 'Proofread', 'Outline', 'Practise'];
const SUBJECTS = [
    'IHM report',
    'linear algebra homework',
    'networks lab',
    'compilers project',
    'English essay',
    'statistics exercises',
    'database schema',
    'OS course notes',
    'history presentation',
    'internship cover letter',
    'graph theory problem set',
    'security CTF write-up',
];
const CHORES = ['Pay rent', 'Book dentist appointment', 'Renew bus pass', 'Call the bank', 'Back up laptop', 'Clean the flat', 'Buy groceries', 'Return library books'];

/**
 * Daily habits and the shape of their history: `days` back from today,
 * done with probability `rate`, with optional forced states for today and
 * yesterday so every streak display is covered.
 */
const HABITS = [
    { title: 'Anki flash cards', severity: 2, days: 45, rate: 1, today: true },
    { title: 'Duolingo', severity: 1, days: 120, rate: 1, today: false },
    { title: '30 min workout', severity: 3, days: 60, rate: 0.6, today: false },
    { title: 'Read 20 pages', severity: 2, days: 30, rate: 0.5, today: true, yesterday: false },
    { title: 'Journal', severity: 1, days: 0, rate: 0, today: false },
    { title: 'Practise guitar', severity: 2, days: 40, rate: 0.9, today: false, yesterday: false },
    { title: 'Meditate', severity: 1, days: 2, rate: 1, today: true },
    { title: 'Code kata', severity: 3, days: 90, rate: 0.75, today: true },
];

/**
 * @param {{ now: Date, seed?: string, counts?: { todo?: number, completed?: number } }} options
 * @returns {{ tasks: import('./tasks.js').Task[], ledger: import('./tick.js').Ledger }}
 */
export function generateDemoData({ now, seed = 'demo', counts = {} }) {
    const rng = createRng(seed);
    const todoCount = counts.todo ?? 30;
    const completedCount = counts.completed ?? 150;
    const tasks = [];
    let nextId = 0;
    const id = () => `demo-${nextId++}`;

    const title = () => (rng.chance(0.2) ? rng.pick(CHORES) : `${rng.pick(ACTIONS)} ${rng.pick(SUBJECTS)}`);
    // A time of day between 08:00 and 23:30, on the half hour
    const at = (base, dayOffset) => {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset);
        d.setHours(rng.int(8, 23), rng.chance(0.5) ? 0 : 30, 0, 0);
        return d;
    };
    const make = (fields, createdAt) => createTask({ title: title(), severity: rng.int(1, 5), recurring: false, ...fields }, { id: id(), now: createdAt });

    // Open tasks: a few overdue, some due today and tomorrow, most later on
    const spread = [
        [0.1, () => -rng.int(1, 4)],
        [0.15, () => 0],
        [0.15, () => 1],
        [0.35, () => rng.int(2, 7)],
        [0.25, () => rng.int(8, 60)],
    ];
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
    let cumulative = 0;
    for (const [share, offset] of spread) {
        // Round the running total, so the parts always add up to todoCount
        const n = Math.round(todoCount * (cumulative + share)) - Math.round(todoCount * cumulative);
        cumulative += share;
        for (let i = 0; i < n; i++) {
            const days = offset();
            // "Due today" tasks stay ahead of now, so they are not overdue yet
            const due = days === 0 ? new Date(Math.min(now.getTime() + rng.int(1, 6) * 3600e3, endOfToday.getTime())) : at(now, days);
            const created = new Date(Math.min(now.getTime() - 3600e3, due.getTime() - rng.int(1, 10) * DAY));
            tasks.push(make({ dueAt: due.toISOString() }, created));
        }
    }

    // Daily tasks in every streak state
    const today = dayKey(now);
    for (const habit of HABITS) {
        let doneOn = [];
        for (let back = habit.days; back >= 1; back--) if (rng.next() < habit.rate) doneOn.push(shiftDay(today, -back));
        if (habit.yesterday === false) doneOn = doneOn.filter((d) => d !== shiftDay(today, -1));
        if (habit.today) doneOn.push(today);
        const created = new Date(now.getTime() - (Math.max(habit.days, 7) + 1) * DAY);
        tasks.push({ ...createTask({ title: habit.title, severity: habit.severity, recurring: true }, { id: id(), now: created }), doneOn });
    }

    // Completed history over the last ~6 months, about 15% finished late
    for (let i = 0; i < completedCount; i++) {
        const completedAt = new Date(now.getTime() - rng.range(0.05, 180) * DAY);
        const late = rng.chance(0.15);
        const due = new Date(completedAt.getTime() + (late ? -rng.range(0.1, 3) : rng.range(0.1, 10)) * DAY);
        const created = new Date(Math.min(completedAt.getTime(), due.getTime()) - rng.range(1, 14) * DAY);
        tasks.push({ ...make({ dueAt: due.toISOString() }, created), completedAt: completedAt.toISOString() });
    }

    // Last settled three days ago, so opening the session credits two days
    return { tasks, ledger: { balance: 85, settledThrough: shiftDay(today, -3) } };
}
