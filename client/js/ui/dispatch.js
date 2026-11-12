/**
 * @file "While you were away" popup: what the settled days brought.
 */

import { h } from './dom.js';

/**
 * @param {HTMLDialogElement} dialog
 */
export function createDispatchDialog(dialog) {
    const body = dialog.querySelector('[data-dispatch-body]');
    dialog.querySelector('[data-dispatch-close]').addEventListener('click', () => dialog.close());
    /** Province picked in the report, focused once the popup is closed. */
    let picked = null;
    let onClose = null;
    dialog.addEventListener('close', () => {
        const id = picked;
        picked = null;
        onClose?.(id);
    });

    /**
     * @param {{ day: string, points: number }[]} granted
     * @param {(import('/engine/combat.js').BattleReport & { day: string })[]} reports
     * @param {import('/engine/mapgen.js').GameMap} map Map before the enemy turns (names, colours).
     * @param {(focusId: number|null) => void} [closed] Called when the popup closes, with the
     *   province picked in the report (or null).
     */
    function show(granted, reports, map, closed) {
        onClose = closed ?? null;
        const player = map.factions.find((f) => f.isPlayer);
        const swatch = (faction) => h('span', { class: 'swatch', style: `background:${map.factions[faction].color}` });
        const name = (id) => map.provinces[id].name;
        /** A province name that closes the report and shows the province on the map. */
        const place = (id) =>
            h(
                'button',
                {
                    type: 'button',
                    class: 'place',
                    title: `Show ${name(id)} on the map`,
                    onclick: () => {
                        picked = id;
                        dialog.close();
                    },
                },
                name(id),
            );
        const date = (day) => new Date(`${day}T12:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

        const sections = [];
        const total = granted.reduce((s, g) => s + g.points, 0);
        sections.push(
            h(
                'section',
                {},
                h('h3', {}, 'Action points'),
                h(
                    'ul',
                    {},
                    ...granted.map((g) =>
                        h('li', {}, `${date(g.day)}: `, h('strong', { class: g.points ? 'pos' : 'neg' }, `+${g.points} AP`)),
                    ),
                ),
                granted.length > 1 && h('p', { class: 'dispatch-total' }, `Total: +${total} AP`),
            ),
        );

        // Attacks on the player's land, then what the player lost
        const onUs = reports.filter((r) => r.defenderFaction === player.id);
        const lostUnits = reports.flatMap((r) => [...r.attackers, ...r.defenders]).filter((o) => o.faction === player.id && !o.after);
        sections.push(
            h(
                'section',
                {},
                h('h3', {}, 'Your front'),
                onUs.length
                    ? h(
                          'ul',
                          {},
                          ...onUs.map((r) =>
                              h(
                                  'li',
                                  { class: r.captured ? 'neg' : 'pos' },
                                  swatch(r.attackerFaction),
                                  ...(r.captured
                                      ? [
                                            `${map.factions[r.attackerFaction].name} ${r.unopposed ? 'took undefended' : 'captured'} `,
                                            place(r.province),
                                        ]
                                      : [place(r.province), ` held against the ${map.factions[r.attackerFaction].name}`]),
                              ),
                          ),
                      )
                    : h('p', { class: 'dispatch-quiet' }, 'No attack on your land.'),
                lostUnits.length > 0 && h('p', { class: 'neg' }, `Units lost: ${lostUnits.map((o) => o.name).join(', ')}.`),
            ),
        );

        // Elsewhere: provinces taken, per attacker and victim
        const elsewhere = new Map();
        for (const r of reports) {
            if (r.defenderFaction === player.id || !r.captured) continue;
            const key = `${r.attackerFaction}:${r.defenderFaction}`;
            elsewhere.set(key, [...(elsewhere.get(key) ?? []), r.province]);
        }
        if (elsewhere.size) {
            sections.push(
                h(
                    'section',
                    {},
                    h('h3', {}, 'Elsewhere'),
                    h(
                        'ul',
                        {},
                        ...[...elsewhere].map(([key, provinces]) => {
                            const [attacker, defender] = key.split(':').map(Number);
                            return h(
                                'li',
                                {},
                                swatch(attacker),
                                `${map.factions[attacker].name} took ${provinces.length} province${provinces.length > 1 ? 's' : ''} from the ${map.factions[defender].name}`,
                                h('small', {}, ' (', ...provinces.flatMap((id, i) => (i ? [', ', place(id)] : [place(id)])), ')'),
                            );
                        }),
                    ),
                ),
            );
        }
        body.replaceChildren(...sections);
        dialog.showModal();
        dialog.querySelector('[data-dispatch-close]').focus();
    }

    return { show };
}
