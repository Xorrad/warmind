/**
 * @file Top bar: logo, version, action points, settings.
 */

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
 * day, with its breakdown in the tooltip.
 * @param {HTMLElement} el
 * @param {number} balance
 * @param {import('/engine/points.js').PointsBreakdown} estimate
 */
export function renderPoints(el, balance, estimate) {
    const penalized = estimate.overdue.length > 0;
    el.querySelector('[data-points-balance]').textContent = String(balance);
    const gain = el.querySelector('[data-points-gain]');
    gain.textContent = `+${estimate.total} tomorrow`;
    gain.classList.toggle('penalized', penalized);
    const lines = [
        `Balance: ${balance} AP`,
        '',
        'Estimated gain at the end of today:',
        `  Faction size: +${estimate.base.toFixed(1)}`,
        `  Unfinished tasks: −${estimate.penalty.toFixed(1)}`,
        `  Completed today: +${estimate.bonus}`,
    ];
    if (penalized) lines.push(`  ${estimate.overdue.length} task(s) overdue by tonight: no points at all!`);
    el.title = lines.join('\n');
}
