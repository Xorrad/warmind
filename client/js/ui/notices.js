/**
 * @file Notices: short typed slips pinned to the top left of the map, for
 * what just happened (orders carried out, tasks checked, errors). The
 * newest is on top; each one fades out after a few seconds, or when
 * clicked. At most MAX are shown.
 */

import { h } from './dom.js';

const MAX = 4;
const LIFETIME_MS = 4500;

/**
 * @param {HTMLElement} container An element with aria-live, holding the slips.
 * @returns {(message: string, kind?: 'info'|'success'|'error', title?: string) => void}
 */
export function createNotices(container) {
    function dismiss(slip) {
        if (slip.classList.contains('leaving')) return;
        slip.classList.add('leaving');
        // After the fade (or at once when animations are off)
        const remove = () => slip.remove();
        slip.addEventListener('animationend', remove, { once: true });
        setTimeout(remove, 400);
    }

    return (message, kind = 'info', title = null) => {
        const slip = h(
            'div',
            { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : null, title: 'Click to dismiss' },
            title && h('strong', { class: 'notice-title' }, title),
            h('span', { class: 'notice-text' }, message),
        );
        slip.addEventListener('click', () => dismiss(slip));
        container.prepend(slip);
        for (const old of [...container.children].slice(MAX)) dismiss(old);
        setTimeout(() => dismiss(slip), kind === 'error' ? LIFETIME_MS + 1500 : LIFETIME_MS);
    };
}
