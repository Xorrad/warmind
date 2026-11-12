/**
 * @file Battle popup: the odds before an attack, then the battle report.
 */

import { TERRAINS } from '/engine/config.js';
import { h } from './dom.js';

const pct = (x) => `${Math.round(x * 100)}%`;
const power = (x) => x.toFixed(1);

/**
 * @param {HTMLDialogElement} dialog
 */
export function createBattleDialog(dialog) {
    const body = dialog.querySelector('[data-battle-body]');
    const actions = dialog.querySelector('[data-battle-actions]');
    const title = dialog.querySelector('[data-battle-title]');

    const swatch = (color) => h('span', { class: 'swatch', style: `background:${color}` });
    const button = (label, cls, onclick) => h('button', { type: 'button', class: cls, onclick }, label);

    /**
     * Show the forces and the odds. Every unit able to join is listed with a
     * checkbox; the odds and the cost follow the ticked ones.
     * @param {{
     *   map: import('/engine/mapgen.js').GameMap,
     *   province: import('/engine/mapgen.js').Province,
     *   candidates: import('/engine/units.js').Unit[],
     *   selected: number[],
     *   balance: number,
     *   evaluate: (ids: number[]) => { forces: ReturnType<typeof import('/engine/combat.js').battleForces>, chance: number, cost: number },
     * }} preview
     * @param {(ids: number[]) => void} onConfirm
     */
    function open({ map, province, candidates, selected, balance, evaluate }, onConfirm) {
        const terrain = TERRAINS[province.terrain];
        const defender = map.factions[province.owner];
        const chosen = new Set(selected);
        title.textContent = `Attack ${province.name}`;
        const unitLine = (u) => [h('strong', {}, u.name), ` · ${u.size} bn · ${u.strength}% · ${pct(u.motivation)} motivation`];

        const attackersBox = h('div', { class: 'battle-side' });
        const defendersBox = h('div', { class: 'battle-side' });
        const odds = h('div', { class: 'battle-odds' });
        const terrainLine = h('p', { class: 'battle-terrain' });
        const confirm = button('Attack', 'primary danger', () => onConfirm([...chosen]));

        function update() {
            const ids = [...chosen];
            const { forces, chance, cost } = evaluate(ids);
            terrainLine.replaceChildren(
                swatch(terrain.color),
                `${terrain.label}: attackers ×${forces.attackModifier.toFixed(2)} and ×${forces.attackBonus} initiative, defenders ×${forces.defenseModifier.toFixed(2)}`,
            );
            attackersBox.replaceChildren(
                h('h3', {}, swatch(map.factions[candidates[0].faction].color), 'Your attack'),
                h(
                    'ul',
                    { class: 'battle-choices' },
                    ...candidates.map((u) =>
                        h(
                            'li',
                            {},
                            h(
                                'label',
                                {},
                                h('input', {
                                    type: 'checkbox',
                                    checked: chosen.has(u.id),
                                    onchange: (e) => {
                                        if (e.target.checked) chosen.add(u.id);
                                        else chosen.delete(u.id);
                                        update();
                                    },
                                }),
                                h('span', {}, ...unitLine(u), h('small', {}, ` · from ${map.provinces[u.province].name}`)),
                            ),
                        ),
                    ),
                ),
                h('p', { class: 'battle-power' }, `Power ${power(forces.attackPower)}`),
            );
            defendersBox.replaceChildren(
                h('h3', {}, swatch(defender.color), defender.name),
                forces.defenders.length
                    ? h('ul', {}, ...forces.defenders.map((u) => h('li', {}, ...unitLine(u))))
                    : h('p', { class: 'battle-empty' }, 'No units: the province is undefended.'),
                h('p', { class: 'battle-power' }, `Power ${power(forces.defensePower)}`),
            );
            const level = !ids.length ? 'bad' : chance >= 0.65 ? 'good' : chance >= 0.35 ? 'even' : 'bad';
            odds.className = `battle-odds ${level}`;
            odds.replaceChildren(...(ids.length ? [h('strong', {}, pct(chance)), ' chance of victory'] : ['Tick at least one unit.']));
            confirm.textContent = `Attack (−${cost} AP)`;
            const blocked = !ids.length ? 'Tick at least one unit.' : cost > balance ? `Needs ${cost} AP, you have ${balance}.` : '';
            confirm.disabled = Boolean(blocked);
            confirm.title = blocked;
        }

        body.replaceChildren(
            terrainLine,
            h('div', { class: 'battle-sides' }, attackersBox, defendersBox),
            odds,
            h(
                'p',
                { class: 'battle-note' },
                'Each side rolls between ×0.6 and ×1.4. Every unit next to the province can join; winners move in, beaten defenders retreat or are destroyed.',
            ),
        );
        update();
        actions.replaceChildren(
            button('Cancel', 'secondary', () => dialog.close()),
            confirm,
        );
        dialog.showModal();
        confirm.focus();
    }

    /**
     * Replace the preview with the outcome.
     * @param {import('/engine/combat.js').BattleReport} report
     * @param {import('/engine/mapgen.js').GameMap} map Map before the battle (names, colours).
     */
    function showResult(report, map) {
        const province = map.provinces[report.province];
        const won = report.winner === 'attacker';
        title.textContent = report.unopposed
            ? `${province.name} taken`
            : won
              ? `Victory at ${province.name}`
              : `Defeat at ${province.name}`;
        const headline = report.unopposed
            ? `${province.name} was undefended: your troops marched in.`
            : won
              ? report.captured
                  ? `The defenders broke: ${province.name} is yours.`
                  : `The defenders broke, but your unit was too battered to hold ${province.name}.`
              : `The attack on ${province.name} was repelled.`;
        const attackerIds = new Set(report.attackers.map((o) => o.id));
        const status = (o) => {
            if (!o.after) return o.surrounded ? 'Surrounded and destroyed' : 'Destroyed';
            if (o.retreatedTo !== undefined) return `Retreated to ${map.provinces[o.retreatedTo].name}`;
            return attackerIds.has(o.id) && o.after.province === report.province ? `Moved into ${province.name}` : 'Holds its position';
        };
        const change = (before, after, unit = '') =>
            after === null ? `${before}${unit} → 0` : before === after ? `${before}${unit}` : `${before}${unit} → ${after}${unit}`;
        const row = (o) =>
            h(
                'tr',
                { class: o.after ? '' : 'destroyed' },
                h('td', {}, swatch(map.factions[o.faction].color), o.name),
                h('td', {}, change(o.before.size, o.after?.size ?? null, ' bn')),
                h('td', {}, change(o.before.strength, o.after?.strength ?? null, '%')),
                h('td', {}, status(o)),
            );
        // (replaceChildren would print `false`: drop the skipped parts)
        const parts = [
            h('p', { class: `battle-result ${won ? 'won' : 'lost'}` }, headline),
            !report.unopposed &&
                h('p', { class: 'battle-note' }, `Rolled power: you ${power(report.attackPower)} against ${power(report.defensePower)}.`),
            h(
                'table',
                { class: 'battle-table' },
                h('thead', {}, h('tr', {}, h('th', {}, 'Unit'), h('th', {}, 'Size'), h('th', {}, 'Strength'), h('th', {}, 'Outcome'))),
                h('tbody', {}, ...report.attackers.map(row), ...report.defenders.map(row)),
            ),
        ];
        body.replaceChildren(...parts.filter(Boolean));
        const close = button('Close', 'primary', () => dialog.close());
        actions.replaceChildren(close);
        close.focus();
    }

    return { open, showResult, close: () => dialog.close() };
}
