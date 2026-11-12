/**
 * @file Top bar: logo, version, action points, settings.
 */

import { POINTS } from '/engine/config.js';
import { h } from './dom.js';
import { now } from '../clock.js';

import { getBuild } from '../api.js';

/**
 * Show the build version next to the logo. Outside production the commit
 * is appended so a dev deployment can be told apart from a tagged release.
 * @param {HTMLElement} el
 */
export async function renderVersion(el) {
    try {
        const build = await getBuild();
        const dev = build.env !== 'production' && build.commit;
        el.textContent = `v${build.version}${dev ? `-dev+${build.commit}` : ''}`;
        el.title = [build.commit && `commit ${build.commit}`, `started ${build.builtAt}`].filter(Boolean).join(', ');
    } catch {
        el.textContent = '';
    }
}

/**
 * Show the action points balance and the estimated gain at the end of the
 * day; the popover (on hover, focus or tap) explains how the gain is made.
 * @param {HTMLElement} el
 * @param {number} balance
 * @param {import('/engine/points.js').PointsBreakdown} estimate
 * @param {{ tasks: import('/engine/tasks.js').Task[], provincesOwned: number, completedToday: number }} details
 */
export function renderPoints(el, balance, estimate, { tasks, provincesOwned, completedToday }) {
    const penalized = estimate.overdue.length > 0;
    el.querySelector('[data-points-balance]').textContent = String(balance);
    const gain = el.querySelector('[data-points-gain]');
    gain.textContent = `+${estimate.total} tomorrow`;
    gain.classList.toggle('penalized', penalized);
    el.querySelector('#points-details').replaceChildren(...popover(balance, estimate, { tasks, provincesOwned, completedToday }));
}

/**
 * Keep the points popover inside the window: when the badge sits near the
 * right edge (narrow screens), slide the card left and keep its arrow on
 * the badge.
 * @param {HTMLElement} el The points badge.
 */
export function setupPointsPopover(el) {
    const pop = el.querySelector('.points-popover');
    const place = () => {
        pop.style.left = '0px';
        pop.style.setProperty('--arrow-left', '24px');
        const overflow = pop.getBoundingClientRect().right - (window.innerWidth - 16);
        if (overflow > 0) {
            pop.style.left = `${-overflow}px`;
            pop.style.setProperty('--arrow-left', `${24 + overflow}px`);
        }
    };
    el.addEventListener('mouseenter', place);
    el.addEventListener('focusin', place);
}

/** "today 21:30" for today, "Tue 19:00" otherwise. */
function shortDue(date) {
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return date.toDateString() === now().toDateString() ? `today ${time}` : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function popover(balance, estimate, { tasks, provincesOwned, completedToday }) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const penalized = estimate.overdue.length > 0;
    const row = (label, value, cls = '') => h('div', { class: `pp-row ${cls}` }, h('span', {}, label), h('span', { class: 'pp-value' }, value));

    const heaviest = [...estimate.penalties]
        .filter((p) => p.amount >= 0.05 && !estimate.overdue.includes(p.taskId))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 3);

    return [
        h('div', { class: 'pp-balance' }, h('strong', {}, String(balance)), ' AP available'),
        h('div', { class: 'pp-section' }, 'Estimated gain at midnight'),
        row(`Faction size (${provincesOwned} provinces)`, `+${fmt(estimate.base)}`),
        row(`${estimate.penalties.length} unfinished task${estimate.penalties.length === 1 ? '' : 's'}`, `−${fmt(estimate.penalty)}`, estimate.penalty ? 'neg' : ''),
        estimate.capped &&
            h('div', { class: 'pp-cap' }, `Capped at ${Math.round(POINTS.maxPenaltyShare * 100)}% of the faction size (−${fmt(estimate.rawPenalty)} without it), shared between all tasks.`),
        row(`${completedToday} completed today`, `+${estimate.bonus}`, estimate.bonus ? 'pos' : ''),
        penalized
            ? row('Overdue task: whole day lost', '0', 'total neg')
            : row('Total', `+${estimate.total}`, 'total'),
        penalized &&
            h(
                'div',
                { class: 'pp-alert' },
                h('strong', {}, 'Overdue by midnight: no points at all'),
                h(
                    'ul',
                    {},
                    ...estimate.overdue.slice(0, 5).map((id) => {
                        const t = byId.get(id);
                        return h('li', {}, t.title, h('small', {}, ` · due ${shortDue(new Date(t.dueAt))}`));
                    }),
                    estimate.overdue.length > 5 && h('li', { class: 'pp-more' }, `+${estimate.overdue.length - 5} more`),
                ),
            ),
        heaviest.length > 0 &&
            h(
                'div',
                { class: 'pp-costly' },
                h('div', { class: 'pp-section' }, 'Costing the most'),
                ...heaviest.map((p) => row(byId.get(p.taskId)?.title ?? '?', `−${fmt(p.amount)}`, 'neg')),
            ),
        h(
            'p',
            { class: 'pp-note' },
            `A task costs its severity × the share of its time already gone. Points are credited when the day ends; completing tasks removes their cost and earns a bonus (up to +${POINTS.completionBonusCap}).`,
        ),
    ].filter(Boolean);
}
