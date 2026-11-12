import { describe, it, expect } from 'vitest';
import { generateDemoData } from '../engine/demo.js';
import { validateTask, partitionTasks, isOverdue, isDoneToday, streakOf } from '../engine/tasks.js';

const now = new Date(2026, 10, 12, 10, 0);
const { tasks, ledger } = generateDemoData({ now });

describe('generateDemoData', () => {
    it('fills every panel with a sizeable list', () => {
        const { todo, streaks, completed } = partitionTasks(tasks, now);
        expect(todo).toHaveLength(30);
        expect(streaks).toHaveLength(8);
        expect(completed).toHaveLength(150);
    });

    it('only produces valid tasks with ids, dates in the past and unique ids', () => {
        for (const t of tasks) {
            expect(validateTask(t)).toEqual({});
            expect(Date.parse(t.createdAt)).toBeLessThanOrEqual(now.getTime());
            if (t.completedAt) expect(Date.parse(t.completedAt)).toBeLessThanOrEqual(now.getTime());
            if (t.completedAt) expect(Date.parse(t.createdAt)).toBeLessThanOrEqual(Date.parse(t.completedAt));
        }
        expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    });

    it('covers overdue, due-today, late and every streak state', () => {
        const open = tasks.filter((t) => !t.recurring && !t.completedAt);
        expect(open.filter((t) => isOverdue(t, now)).length).toBeGreaterThan(0);
        expect(open.filter((t) => !isOverdue(t, now) && new Date(t.dueAt).getDate() === now.getDate()).length).toBeGreaterThan(0);
        expect(tasks.filter((t) => t.completedAt && Date.parse(t.completedAt) > Date.parse(t.dueAt)).length).toBeGreaterThan(0);

        const daily = tasks.filter((t) => t.recurring);
        const kept = daily.filter((t) => isDoneToday(t, now) && streakOf(t, now) > 1);
        const atRisk = daily.filter((t) => !isDoneToday(t, now) && streakOf(t, now) > 0);
        const none = daily.filter((t) => streakOf(t, now) === 0);
        expect(kept.length && atRisk.length && none.length).toBeGreaterThan(0);
    });

    it('leaves days to settle and is deterministic for a given seed', () => {
        expect(ledger.settledThrough).toBe('2026-11-09');
        expect(generateDemoData({ now })).toEqual({ tasks, ledger });
        expect(generateDemoData({ now, seed: 'other' }).tasks).not.toEqual(tasks);
    });
});

