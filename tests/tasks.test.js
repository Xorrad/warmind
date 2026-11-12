import { describe, it, expect } from 'vitest';
import {
    createTask,
    updateTask,
    validateTask,
    toggleDone,
    isDoneToday,
    isOverdue,
    streakOf,
    partitionTasks,
    dayKey,
    shiftDay,
} from '../engine/tasks.js';
import { computeDailyPoints, elapsedShare } from '../engine/points.js';
import { settleDays, estimateToday, endOfDay, completionGains } from '../engine/tick.js';
import { POINTS } from '../engine/config.js';

// Fixed local "now": 12 Nov 2026, 10:00
const now = new Date(2026, 10, 12, 10, 0);
const inDays = (d) => new Date(now.getTime() + d * 24 * 3600 * 1000).toISOString();
let nextId = 0;
const oneOff = (fields = {}) =>
    createTask({ title: 'Essay', severity: 3, recurring: false, dueAt: inDays(2), ...fields }, { id: `t${nextId++}`, now });
const daily = (fields = {}) => createTask({ title: 'Flash cards', severity: 2, recurring: true, ...fields }, { id: `t${nextId++}`, now });

describe('days', () => {
    it('formats the local day and shifts across month ends', () => {
        expect(dayKey(now)).toBe('2026-11-12');
        expect(shiftDay('2026-11-30', 1)).toBe('2026-12-01');
        expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    });
});

describe('validateTask', () => {
    it('accepts a valid one-off task', () => {
        expect(validateTask({ title: 'Read', severity: 5, recurring: false, dueAt: inDays(1) })).toEqual({});
    });

    it('reports every invalid field', () => {
        const errors = validateTask({ title: '  ', severity: 0, recurring: false, dueAt: '' });
        expect(Object.keys(errors).sort()).toEqual(['dueAt', 'severity', 'title']);
    });

    it('does not require a due date for recurring tasks', () => {
        expect(validateTask({ title: 'Run', severity: 1, recurring: true })).toEqual({});
    });

    it('refuses to create an invalid task', () => {
        expect(() => oneOff({ title: '' })).toThrow();
    });
});

describe('one-off tasks', () => {
    it('trims the title and stores the due date as ISO', () => {
        const t = oneOff({ title: '  Essay  ' });
        expect(t.title).toBe('Essay');
        expect(t.dueAt).toBe(inDays(2));
        expect(t.completedAt).toBeNull();
    });

    it('can be completed and reopened', () => {
        const done = toggleDone(oneOff(), now);
        expect(isDoneToday(done, now)).toBe(true);
        expect(isDoneToday(toggleDone(done, now), now)).toBe(false);
    });

    it('is overdue only while unfinished and past its due date', () => {
        const late = oneOff({ dueAt: inDays(-0.1) });
        expect(isOverdue(late, now)).toBe(true);
        expect(isOverdue(toggleDone(late, now), now)).toBe(false);
        expect(isOverdue(oneOff(), now)).toBe(false);
    });

    it('keeps id and history when edited', () => {
        const t = toggleDone(oneOff(), now);
        const edited = updateTask(t, { title: 'Report', severity: 1, recurring: false, dueAt: inDays(5) });
        expect(edited).toMatchObject({ id: t.id, title: 'Report', severity: 1, completedAt: t.completedAt });
        expect(edited).not.toHaveProperty('priority');
    });
});

describe('recurring tasks', () => {
    it('are never overdue and toggle per day', () => {
        const t = toggleDone(daily(), now);
        expect(isOverdue(t, now)).toBe(false);
        expect(t.doneOn).toEqual(['2026-11-12']);
        expect(toggleDone(t, now).doneOn).toEqual([]);
    });

    it('count consecutive days, today not yet being required', () => {
        const t = { ...daily(), doneOn: ['2026-11-08', '2026-11-10', '2026-11-11'] };
        expect(streakOf(t, now)).toBe(2);
        expect(streakOf(toggleDone(t, now), now)).toBe(3);
    });

    it('lose their streak after a missed day', () => {
        const t = { ...daily(), doneOn: ['2026-11-09', '2026-11-10'] };
        expect(streakOf(t, now)).toBe(0);
    });
});

describe('partitionTasks', () => {
    it('sorts tasks into todo, streaks and completed, keeping daily tasks in streaks', () => {
        const late = oneOff({ title: 'Late', dueAt: inDays(-1) });
        const soon = oneOff({ title: 'Soon', dueAt: inDays(1) });
        const later = oneOff({ title: 'Later', dueAt: inDays(4) });
        const doneNow = toggleDone(oneOff({ title: 'Done' }), now);
        const doneBefore = { ...oneOff({ title: 'Old' }), completedAt: inDays(-3) };
        const run = daily({ title: 'Run' });
        const cards = toggleDone(daily({ title: 'Cards' }), now);

        const { todo, streaks, completed } = partitionTasks([later, run, doneNow, soon, cards, late, doneBefore], now);
        expect(todo.map((t) => t.title)).toEqual(['Late', 'Soon', 'Later']);
        expect(streaks.map((t) => t.title)).toEqual(['Run', 'Cards']);
        expect(completed.map((t) => t.title)).toEqual(['Done', 'Old']);
    });
});

describe('computeDailyPoints', () => {
    const provincesOwned = 10;
    const base = POINTS.base + POINTS.perProvince * provincesOwned;

    it('grants the base amount with an empty list', () => {
        expect(computeDailyPoints([], { provincesOwned, now }).total).toBe(Math.round(base));
    });

    it('measures the share of its time a task has used up', () => {
        // Created 3 days ago, due in 1 day: 3/4 of its time is gone
        const t = { ...oneOff({ dueAt: inDays(1) }), createdAt: inDays(-3) };
        expect(elapsedShare(t, now)).toBeCloseTo(0.75);
        expect(elapsedShare({ ...t, createdAt: now.toISOString() }, now)).toBe(0);
        expect(elapsedShare({ ...t, dueAt: inDays(-1) }, now)).toBe(1);
        // Daily tasks run over their day: 10:00 is 10/24 of it
        expect(elapsedShare(daily(), now)).toBeCloseTo(10 / 24, 3);
    });

    it('subtracts severity × elapsed / total for each unfinished task', () => {
        const t = { ...oneOff({ severity: 4, dueAt: inDays(1) }), createdAt: inDays(-3) };
        const result = computeDailyPoints([t], { provincesOwned, now });
        expect(result.penalty).toBeCloseTo(3);
        expect(result.capped).toBe(false);
        expect(result.total).toBe(Math.round(base - 3));
    });

    it('caps the losses at 90% of the base, shared in proportion', () => {
        const heavy = { ...oneOff({ severity: 5, dueAt: inDays(1) }), createdAt: inDays(-9) }; // 5 × 0.9 = 4.5
        const light = { ...oneOff({ severity: 1, dueAt: inDays(1) }), createdAt: inDays(-9) }; // 0.9
        const many = Array.from({ length: 6 }, () => ({ ...heavy, id: heavy.id + Math.random() }));
        const result = computeDailyPoints([...many, light], { provincesOwned, now });
        expect(result.rawPenalty).toBeCloseTo(6 * 4.5 + 0.9);
        expect(result.capped).toBe(true);
        expect(result.penalty).toBeCloseTo(POINTS.maxPenaltyShare * base);
        const amount = (id) => result.penalties.find((p) => p.taskId === id).amount;
        expect(amount(many[0].id) / amount(light.id)).toBeCloseTo(5);
        expect(result.total).toBe(Math.round(base * (1 - POINTS.maxPenaltyShare)));
    });

    it('charges unfinished daily tasks for the part of the day gone, all of it by midnight', () => {
        const run = daily({ severity: 2 });
        expect(computeDailyPoints([run], { provincesOwned, now }).penalty).toBeCloseTo(2 * (10 / 24), 3);
        expect(computeDailyPoints([run], { provincesOwned, now: endOfDay('2026-11-12') }).penalty).toBeCloseTo(2, 5);
    });

    it('rewards tasks completed today, up to the cap', () => {
        const done = Array.from({ length: 20 }, () => toggleDone(oneOff(), now));
        const result = computeDailyPoints(done, { provincesOwned, now });
        expect(result.bonus).toBe(POINTS.completionBonusCap);
        expect(result.penalty).toBe(0);
    });

    it('drops to zero when any task is overdue', () => {
        const late = oneOff({ dueAt: inDays(-1) });
        const result = computeDailyPoints([late, toggleDone(oneOff(), now)], { provincesOwned, now });
        expect(result.overdue).toEqual([late.id]);
        expect(result.total).toBe(0);
    });

    it('always leaves something when nothing is overdue', () => {
        const heavy = Array.from({ length: 30 }, () => ({ ...oneOff({ severity: 5, dueAt: inDays(0.1) }), createdAt: inDays(-5) }));
        expect(computeDailyPoints(heavy, { provincesOwned, now }).total).toBeGreaterThan(0);
    });
});

describe('computeDailyPoints as of a past moment', () => {
    const provincesOwned = 10;

    it('ignores tasks created later', () => {
        const future = createTask(
            { title: 'Later', severity: 5, recurring: false, dueAt: inDays(1) },
            { id: 'f', now: new Date(now.getTime() + 3600e3) },
        );
        expect(computeDailyPoints([future], { provincesOwned, now }).penalty).toBe(0);
    });

    it('treats tasks completed later as unfinished', () => {
        const t = { ...oneOff({ dueAt: inDays(-0.5) }), completedAt: inDays(1) };
        expect(computeDailyPoints([t], { provincesOwned, now }).total).toBe(0);
    });
});

describe('settleDays', () => {
    const provincesOwned = 10;
    const base = Math.round(POINTS.base + POINTS.perProvince * provincesOwned);

    it('starts a new campaign without back-pay', () => {
        const { ledger, granted } = settleDays({ balance: 0, settledThrough: null }, [], { provincesOwned, now });
        expect(ledger).toEqual({ balance: 0, settledThrough: '2026-11-11' });
        expect(granted).toEqual([]);
    });

    it('grants each ended day once', () => {
        const start = { balance: 3, settledThrough: '2026-11-09' };
        const { ledger, granted } = settleDays(start, [], { provincesOwned, now });
        expect(granted.map((g) => g.day)).toEqual(['2026-11-10', '2026-11-11']);
        expect(ledger).toEqual({ balance: 3 + 2 * base, settledThrough: '2026-11-11' });
        expect(settleDays(ledger, [], { provincesOwned, now }).granted).toEqual([]);
    });

    it('judges each day on the tasks as they were at its end', () => {
        // Created on the 9th, due on the 10th at noon, completed today (the 12th)
        const t = {
            ...createTask(
                { title: 'Lab', severity: 3, recurring: false, dueAt: new Date(2026, 10, 10, 12).toISOString() },
                { id: 'lab', now: new Date(2026, 10, 9, 9) },
            ),
            completedAt: now.toISOString(),
        };
        const { granted } = settleDays({ balance: 0, settledThrough: '2026-11-08' }, [t], { provincesOwned, now });
        const byDay = Object.fromEntries(granted.map((g) => [g.day, g.points]));
        expect(byDay['2026-11-09']).toBeGreaterThan(0); // pending, not yet due
        expect(byDay['2026-11-10']).toBe(0); // overdue at the end of the 10th
        expect(byDay['2026-11-11']).toBe(0);
    });

    it('rewards daily tasks done on the day itself', () => {
        const run = { ...daily({ severity: 4 }), createdAt: new Date(2026, 10, 1).toISOString(), doneOn: ['2026-11-10'] };
        const { granted } = settleDays({ balance: 0, settledThrough: '2026-11-09' }, [run], { provincesOwned, now });
        expect(granted[0].points).toBe(base + POINTS.completionBonus);
        expect(granted[1].points).toBe(base - 4);
    });
});

describe('estimateToday', () => {
    it('counts a task due later today as overdue if left unfinished', () => {
        const dueTonight = oneOff({ dueAt: new Date(2026, 10, 12, 20).toISOString() });
        expect(estimateToday([dueTonight], { provincesOwned: 10, now }).total).toBe(0);
        expect(estimateToday([toggleDone(dueTonight, now)], { provincesOwned: 10, now }).total).toBeGreaterThan(0);
    });

    it('evaluates at the very end of the day', () => {
        expect(endOfDay('2026-11-12').getTime()).toBe(new Date(2026, 10, 13).getTime() - 1);
    });
});

describe('completionGains', () => {
    const ctx = { provincesOwned: 10, now };

    it('equals the rise in the estimate when the task is completed', () => {
        const a = oneOff({ title: 'A', severity: 5, dueAt: inDays(1) });
        const b = oneOff({ title: 'B', severity: 2, dueAt: inDays(3) });
        const gains = completionGains([a, b], ctx);
        const before = estimateToday([a, b], ctx).total;
        expect(gains.get(a.id)).toBe(estimateToday([toggleDone(a, now), b], ctx).total - before);
        expect(gains.get(a.id)).toBeGreaterThan(gains.get(b.id));
    });

    it('credits an overdue task with unlocking the whole day', () => {
        const late = oneOff({ dueAt: inDays(-1) });
        expect(completionGains([late], ctx).get(late.id)).toBe(estimateToday([toggleDone(late, now)], ctx).total);
    });

    it('is zero while another task stays overdue', () => {
        const late1 = oneOff({ dueAt: inDays(-1) });
        const late2 = oneOff({ dueAt: inDays(-2) });
        expect(completionGains([late1, late2], ctx).get(late1.id)).toBe(0);
    });

    it('covers daily tasks not done today and skips finished tasks', () => {
        const run = daily({ severity: 3 });
        const done = toggleDone(oneOff(), now);
        const gains = completionGains([run, done, toggleDone(daily(), now)], ctx);
        expect([...gains.keys()]).toEqual([run.id]);
        expect(gains.get(run.id)).toBeGreaterThan(0);
    });
});
