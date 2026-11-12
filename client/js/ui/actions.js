/**
 * @file Action bar (bottom right of the map).
 *
 * Shows the actions of the selected unit with their cost. Disabled buttons
 * explain why in their tooltip. The bar only reports clicks; main.js
 * validates and applies the actions.
 */

import { h } from './dom.js';

/** Actions in display order, with a short icon. */
const ACTIONS = [
    { type: 'move', label: 'Move', icon: '➜' },
    { type: 'attack', label: 'Attack', icon: '⚔' },
    { type: 'strengthen', label: 'Strengthen', icon: '⛨' },
    { type: 'merge', label: 'Merge', icon: '⧉' },
    { type: 'split', label: 'Split', icon: '✂' },
];

/**
 * @typedef {object} ActionState
 * @property {boolean} ok Whether the action can be done now.
 * @property {string} [cost] Cost to display ("2", "1–2").
 * @property {string} [reason] Why it cannot be done.
 */

/**
 * Render the action bar.
 * @param {HTMLElement} el
 * @param {{
 *   unit: import('/engine/units.js').Unit|null,
 *   label?: string,
 *   own: boolean,
 *   states: Record<string, ActionState>,
 *   mode: string|null,
 *   hint?: string,
 * }} view
 * @param {(type: string) => void} onAction
 */
export function renderActionBar(el, { unit, label: heading, own, states, mode, hint }, onAction) {
    if (!unit) {
        el.replaceChildren(h('p', { class: 'action-hint' }, 'Select one of your units on the map.'));
        return;
    }
    if (!own) {
        el.replaceChildren(
            h('div', { class: 'action-unit' }, heading ?? unit.name),
            h('p', { class: 'action-hint' }, hint ?? 'This unit is not yours.'),
        );
        return;
    }
    const buttons = ACTIONS.map(({ type, label, icon }) => {
        const state = states[type] ?? { ok: false, reason: 'Not available.' };
        const enabled = state.ok;
        const title = enabled ? `${label}${state.cost ? ` (${state.cost} AP)` : ''}` : state.reason;
        return h(
            'button',
            {
                type: 'button',
                class: `action${mode === type ? ' active' : ''}`,
                disabled: !enabled,
                'aria-pressed': ['move', 'attack', 'merge'].includes(type) ? String(mode === type) : null,
                title,
                'aria-label': title,
                onclick: () => onAction(type),
            },
            h('span', { class: 'action-icon', 'aria-hidden': 'true' }, icon),
            h('span', { class: 'action-label' }, label),
            state.cost && h('span', { class: 'action-cost' }, `${state.cost} AP`),
        );
    });
    const parts = [
        h('div', { class: 'action-unit' }, heading ?? unit.name),
        h('div', { class: 'action-buttons' }, ...buttons),
        hint && h('p', { class: 'action-hint' }, hint),
    ];
    el.replaceChildren(...parts.filter(Boolean));
}
