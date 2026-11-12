/**
 * @file Map interaction: selecting provinces and units, the info card, the
 * action bar and unit actions.
 *
 * Selection:
 *  - click a unit to select it alone (also when it was part of a group);
 *    click the only selected unit again to deselect it;
 *  - shift+click adds one of your units to the selection;
 *  - ctrl+click (⌘ on macOS) removes a unit from the selection.
 *
 * With units of yours selected, provinces they can move to are yellow and
 * the ones they can attack are red (with the odds); clicking a yellow one
 * moves every selected unit that can go there, a red one opens the battle
 * popup with the selected units next to it ticked. The Move and Attack
 * buttons narrow the highlights to one kind. Every action goes through the
 * engine's validateAction() and spends action points from the ledger.
 */

import { TERRAINS, UNITS, ACTION_COSTS } from '/engine/config.js';
import { validateAction, applyAction, moveTargets, attackTargets, attackCost, possibleAttackers } from '/engine/actions.js';
import { unitsIn, movesLeft } from '/engine/units.js';
import { battleForces, winChance } from '/engine/combat.js';
import { renderActionBar } from './ui/actions.js';
import { h } from './ui/dom.js';

/**
 * @param {{
 *   view: ReturnType<typeof import('./ui/map.js').createMapView>,
 *   store: typeof import('./store.js').store,
 *   getMap: () => import('/engine/mapgen.js').GameMap|null,
 *   info: HTMLElement,
 *   actionBar: HTMLElement,
 *   toast: HTMLElement,
 *   battle: ReturnType<typeof import('./ui/battle.js').createBattleDialog>,
 * }} deps
 */
export function createGameController({ view, store, getMap, info, actionBar, toast, battle }) {
    /**
     * Selected unit ids (the first one is the "primary": its province is
     * shown in the info card), and what the highlights show: 'orders' (moves
     * and attacks), 'move', 'attack', or 'merge' (pick the other unit).
     * Several units can only be selected when they are all the player's.
     * @type {number[]}
     */
    let selection = [];
    let mode = null;
    let province = null;

    const campaign = () => store.get().campaign;
    const player = () => getMap().factions.find((f) => f.isPlayer);
    const unitById = (id) => campaign()?.units.find((u) => u.id === id) ?? null;
    const actor = () => ({ faction: player().id, balance: store.get().ledger.balance });
    const isOwn = (unit) => unit?.faction === player().id;
    /** The selected units that still exist. */
    const selectedUnits = () => selection.map(unitById).filter(Boolean);
    const ownSelection = () => selectedUnits().filter(isOwn);

    /* ---------- Messages ---------- */

    let toastTimer = null;
    function say(message, kind = 'info') {
        toast.textContent = message;
        toast.className = `toast ${kind}`;
        toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (toast.hidden = true), 3500);
    }

    /* ---------- Targets of the selection ---------- */

    /** Provinces the selection can move to: which units can go and the total cost. */
    function groupMoves(units) {
        const byProvince = new Map();
        for (const u of units) {
            for (const t of moveTargets(campaign(), getMap(), u.id)) {
                const entry = byProvince.get(t.province) ?? { province: t.province, units: [], cost: 0 };
                entry.units.push(u.id);
                entry.cost += t.cost;
                byProvince.set(t.province, entry);
            }
        }
        return [...byProvince.values()];
    }

    /** Provinces the selection can attack, with the selected units next to each. */
    function groupAttacks(units) {
        const byProvince = new Map();
        for (const u of units) {
            for (const id of attackTargets(campaign(), getMap(), u.id)) byProvince.set(id, [...(byProvince.get(id) ?? []), u.id]);
        }
        return [...byProvince].map(([provinceId, ids]) => ({ province: provinceId, units: ids }));
    }

    /* ---------- Actions ---------- */

    /** What each action of the selection would do right now. */
    function actionStates(units) {
        const c = campaign();
        const map = getMap();
        const { balance } = actor();
        const primary = units[0];
        const check = (action) => {
            const v = validateAction(c, map, actor(), action);
            return { ok: v.ok, cost: v.cost !== undefined ? String(v.cost) : undefined, reason: v.ok ? undefined : v.reason };
        };

        const rested = units.some((u) => movesLeft(u) > 0);
        const tired = units.length > 1 ? 'The selected units have already moved today.' : `${primary.name} has already moved today.`;
        const moves = groupMoves(units);
        const costs = [...new Set(moves.map((m) => m.cost))].sort((a, b) => a - b);
        const move = !rested
            ? { ok: false, reason: tired }
            : moves.length
              ? {
                    ok: costs[0] <= balance,
                    cost: costs.length > 1 ? `${costs[0]}–${costs.at(-1)}` : String(costs[0]),
                    reason: `Needs ${costs[0]} AP, you have ${balance}.`,
                }
              : { ok: false, reason: 'No province of yours next to the selection.' };

        const attack = !rested
            ? { ok: false, reason: tired }
            : groupAttacks(units).length
              ? { ok: balance >= attackCost(1), cost: String(attackCost(1)), reason: `Needs ${attackCost(1)} AP, you have ${balance}.` }
              : { ok: false, reason: 'No enemy province next to the selection.' };

        const toStrengthen = units.filter((u) => u.strength < UNITS.maxStrength);
        const strengthenCost = toStrengthen.length * ACTION_COSTS.strengthen;
        const strengthen = !toStrengthen.length
            ? { ok: false, reason: units.length > 1 ? 'The selected units are fully equipped.' : 'The unit is already fully equipped.' }
            : { ok: strengthenCost <= balance, cost: String(strengthenCost), reason: `Needs ${strengthenCost} AP, you have ${balance}.` };

        let merge;
        if (units.length > 1) {
            const together = units.filter((u) => u.province === primary.province);
            const size = together.reduce((s, u) => s + u.size, 0);
            const cost = (together.length - 1) * ACTION_COSTS.merge;
            merge =
                together.length < 2
                    ? { ok: false, reason: `Select units standing in ${map.provinces[primary.province].name} to merge them.` }
                    : size > UNITS.maxSize
                      ? { ok: false, reason: `Together they would exceed ${UNITS.maxSize} battalions.` }
                      : { ok: cost <= balance, cost: String(cost), reason: `Needs ${cost} AP, you have ${balance}.` };
        } else {
            const others = unitsIn(c, primary.province).filter((u) => u.id !== primary.id && u.faction === primary.faction);
            const checks = others.map((o) => check({ type: 'merge', unitId: primary.id, otherId: o.id }));
            merge = others.length
                ? (checks.find((m) => m.ok) ?? checks[0])
                : { ok: false, reason: 'No other unit of yours in this province.' };
        }

        const split =
            units.length > 1 ? { ok: false, reason: 'Select a single unit to split it.' } : check({ type: 'split', unitId: primary.id });
        return { move, attack, strengthen, merge, split };
    }

    /**
     * Validate, apply and pay for an action.
     * @param {object} action
     * @returns {number|false} The cost paid, or false (the reason is shown).
     */
    function run(action) {
        const map = getMap();
        const v = validateAction(campaign(), map, actor(), action);
        if (!v.ok) {
            say(v.reason, 'error');
            return false;
        }
        store.update((s) => ({
            ...s,
            campaign: applyAction(s.campaign, action, map),
            ledger: { ...s.ledger, balance: s.ledger.balance - v.cost },
        }));
        return v.cost;
    }

    /** Run several actions in a row (stops at the first refused one) and report once. */
    function runAll(actions, message) {
        let spent = 0;
        let done = 0;
        for (const action of actions) {
            const cost = run(action);
            if (cost === false) break;
            spent += cost;
            done++;
        }
        if (done) say(`${message(done)} (−${spent} AP)`, 'success');
        return done;
    }

    /**
     * Open the battle popup for an attack on a province, with `ticked` units
     * pre-selected; every other unit of the player next to it can be added.
     */
    function openAttack(target, ticked) {
        const map = getMap();
        const c = campaign();
        const candidates = possibleAttackers(c, map, player().id, target.id).sort((a, b) => {
            const rank = (u) => (ticked.includes(u.id) ? ticked.indexOf(u.id) : ticked.length + u.id);
            return rank(a) - rank(b);
        });
        const evaluate = (ids) => {
            const forces = battleForces(c, map, ids, target.id);
            return { forces, chance: winChance(forces.attackPower, forces.defensePower), cost: attackCost(Math.max(1, ids.length)) };
        };
        battle.open({ map, province: target, candidates, selected: ticked, balance: actor().balance, evaluate }, (ids) => {
            const cost = run({ type: 'attack', unitIds: ids, to: target.id });
            if (cost === false) {
                battle.close();
            } else {
                const r = campaign().log.at(-1);
                if (r.captured) say(`${target.name} captured (−${cost} AP)`, 'success');
                else
                    say(
                        `${r.winner === 'attacker' ? `${target.name} held despite the victory` : `Attack on ${target.name} repelled`} (−${cost} AP)`,
                        'error',
                    );
                battle.showResult(r, map);
            }
            refresh();
        });
    }

    /**
     * Remove the province outline the map draws on click. The map reports
     * it as a deselection, which would reset the current selection: keep it.
     */
    function clearOutline() {
        const keep = [selection, mode, province];
        view.select(null);
        [selection, mode, province] = keep;
    }

    const showsMoves = () => mode === 'orders' || mode === 'move';
    const showsAttacks = () => mode === 'orders' || mode === 'attack';

    function onAction(type) {
        const units = ownSelection();
        if (!units.length) return;
        const [primary] = units;
        switch (type) {
            case 'move':
            case 'attack':
                mode = mode === type ? 'orders' : type;
                break;
            case 'strengthen': {
                const todo = units.filter((u) => u.strength < UNITS.maxStrength);
                runAll(
                    todo.map((u) => ({ type, unitId: u.id })),
                    (n) => (n === 1 ? `${todo[0].name} resupplied` : `${n} units resupplied`),
                );
                break;
            }
            case 'split':
                runAll([{ type, unitId: primary.id }], () => `${primary.name} split in two`);
                break;
            case 'merge': {
                if (units.length > 1) {
                    const others = units.filter((u) => u !== primary && u.province === primary.province);
                    if (
                        runAll(
                            others.map((o) => ({ type, unitId: primary.id, otherId: o.id })),
                            (n) => `${n} unit${n > 1 ? 's' : ''} merged into ${primary.name}`,
                        )
                    ) {
                        selection = [primary.id];
                    }
                    mode = 'orders';
                    break;
                }
                const others = unitsIn(campaign(), primary.province).filter((u) => u.id !== primary.id && u.faction === primary.faction);
                if (others.length === 1) {
                    runAll([{ type, unitId: primary.id, otherId: others[0].id }], () => `${others[0].name} merged into ${primary.name}`);
                    mode = 'orders';
                } else {
                    mode = mode === 'merge' ? 'orders' : 'merge';
                    if (mode === 'merge') say(`Click the unit to merge into ${primary.name}.`);
                }
                break;
            }
            default:
                say(`${type} is not available yet.`, 'error');
        }
        refresh();
    }

    /* ---------- Selection ---------- */

    /**
     * Unit clicks (on the map or in the info card).
     * @param {number} id
     * @param {{ shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean }} [modifiers]
     */
    function selectUnit(id, { shiftKey = false, ctrlKey = false, metaKey = false } = {}) {
        const unit = unitById(id);
        if (!unit) return;
        const own = ownSelection();

        // Second step of a merge: the clicked unit joins the primary one
        if (mode === 'merge' && own.length && id !== own[0].id) {
            if (runAll([{ type: 'merge', unitId: own[0].id, otherId: id }], () => `${unit.name} merged into ${own[0].name}`))
                mode = 'orders';
            refresh();
            return;
        }

        // Ctrl / ⌘ + click: take the unit out of the selection
        if (ctrlKey || metaKey) {
            selection = selection.filter((s) => s !== id);
            if (!selection.length) mode = null;
            refresh();
            return;
        }

        // Shift + click: add one of your units to the selection
        if (shiftKey) {
            if (!isOwn(unit)) {
                say('Only your own units can be selected together.', 'error');
                return;
            }
            clearOutline();
            selection = [...(own.length === selection.length ? selection : []).filter((s) => s !== id), id];
            province ??= unit.province;
            mode ??= 'orders';
            refresh();
            return;
        }

        // Clicking an enemy counter in a province the selection can attack
        if (own.length && !isOwn(unit) && showsAttacks()) {
            const attack = groupAttacks(own).find((a) => a.province === unit.province);
            if (attack) {
                openAttack(getMap().provinces[unit.province], attack.units);
                return;
            }
        }

        // Clicking the only selected unit again deselects it
        if (selection.length === 1 && selection[0] === id) {
            selection = [];
            mode = null;
            refresh();
            return;
        }

        clearOutline();
        selection = [id];
        province = unit.province;
        mode = isOwn(unit) ? 'orders' : null;
        refresh();
    }

    /**
     * Province clicks: a yellow target moves the selection there, a red one
     * opens the battle popup, anything else selects the province.
     */
    function selectProvince(p) {
        const own = ownSelection();
        if (p && own.length) {
            if (showsMoves()) {
                const move = groupMoves(own).find((m) => m.province === p.id);
                if (move) {
                    clearOutline();
                    runAll(
                        move.units.map((id) => ({ type: 'move', unitId: id, to: p.id })),
                        (n) => (n === 1 ? `${unitById(move.units[0]).name} moved to ${p.name}` : `${n} units moved to ${p.name}`),
                    );
                    refresh();
                    return;
                }
            }
            if (showsAttacks()) {
                const attack = groupAttacks(own).find((a) => a.province === p.id);
                if (attack) {
                    clearOutline();
                    openAttack(p, attack.units);
                    refresh();
                    return;
                }
            }
        }
        province = p?.id ?? null;
        // Keep the selection when clicking the province the primary unit stands in
        if (p === null || !selectedUnits().length || selectedUnits()[0].province !== p.id) {
            selection = [];
            mode = null;
        }
        refresh();
    }

    /** Escape: leave a narrowed mode, then drop the selection, then the province. */
    function clear() {
        if (mode === 'merge' || mode === 'move' || mode === 'attack') mode = 'orders';
        else if (selection.length) {
            selection = [];
            mode = null;
        } else {
            view.select(null);
            return;
        }
        refresh();
    }

    /* ---------- Rendering ---------- */

    function refresh() {
        const map = getMap();
        const c = campaign();
        if (!map || !c) return;
        selection = selectedUnits().map((u) => u.id);
        if (!selection.length) mode = null;
        const units = selectedUnits();
        const primary = units[0] ?? null;
        const own = units.length > 0 && units.every(isOwn);

        const candidates =
            mode === 'merge' && primary
                ? unitsIn(c, primary.province)
                      .filter((u) => u.id !== primary.id && u.faction === primary.faction)
                      .map((u) => u.id)
                : [];
        view.renderUnits(c.units, { selectedIds: selection, candidates });

        const { balance } = actor();
        const targets = [];
        if (own && showsMoves()) {
            for (const m of groupMoves(units))
                targets.push({ province: m.province, kind: 'move', label: `${m.cost} AP`, affordable: m.cost <= balance });
        }
        if (own && showsAttacks()) {
            for (const a of groupAttacks(units)) {
                const f = battleForces(c, map, a.units, a.province);
                const label = `⚔ ${Math.round(winChance(f.attackPower, f.defensePower) * 100)}%`;
                targets.push({ province: a.province, kind: 'attack', label, affordable: attackCost(a.units.length) <= balance });
            }
        }
        view.showTargets(targets);

        const hints = {
            orders: 'Yellow: move there. Red: attack. Shift+click to add units, ctrl+click to remove.',
            move: 'Click a yellow province to move there.',
            attack: 'Click a red province to attack it.',
            merge: 'Click the unit to merge with.',
        };
        renderActionBar(
            actionBar,
            {
                unit: primary,
                label: units.length > 1 ? `${units.length} units selected` : primary?.name,
                own,
                states: own ? actionStates(units) : {},
                mode,
                hint: primary && !own ? `This unit belongs to the ${map.factions[primary.faction].name}.` : hints[mode],
            },
            onAction,
        );
        renderInfo(primary);
    }

    /** The card in the top left: the province of the primary unit (or the selected province) and its units. */
    function renderInfo(primary) {
        const map = getMap();
        const p = primary ? map.provinces[primary.province] : province !== null ? map.provinces[province] : null;
        if (!p) {
            info.hidden = true;
            return;
        }
        const swatch = (color) => h('span', { class: 'swatch', style: `background:${color}` });
        const names = (ids) => ids.map((n) => map.provinces[n].name).join(', ');
        const terrain = TERRAINS[p.terrain];
        const rows = [];
        if (p.owner === -1) {
            rows.push(['Terrain', [swatch(terrain.color), `${terrain.label} (impassable)`]], ['Borders', [names(p.borders)]]);
        } else {
            const owner = map.factions[p.owner];
            rows.push(
                ['Owner', [swatch(owner.color), owner.name]],
                ['Terrain', [swatch(terrain.color), terrain.label]],
                ['Neighbours', [names(p.neighbours)]],
            );
        }
        const here = unitsIn(campaign(), p.id);
        info.replaceChildren(
            ...[
                h('h2', {}, `${p.name}${p.isCapital ? ' ★' : ''}`),
                h('dl', {}, ...rows.flatMap(([dt, dd]) => [h('dt', {}, dt), h('dd', {}, ...dd)])),
                here.length > 0 &&
                    h(
                        'ul',
                        { class: 'unit-list' },
                        ...here.map((u) => {
                            const selected = selection.includes(u.id);
                            return h(
                                'li',
                                {},
                                h(
                                    'button',
                                    {
                                        type: 'button',
                                        class: `unit-row${selected ? ' selected' : ''}`,
                                        'aria-pressed': String(selected),
                                        onclick: (e) => selectUnit(u.id, e),
                                    },
                                    swatch(map.factions[u.faction].color),
                                    h('span', { class: 'unit-name' }, u.name),
                                    h('span', { class: 'unit-stats' }, `${u.size} bn`),
                                ),
                                u.id === primary?.id && unitDetails(u),
                            );
                        }),
                    ),
            ].filter(Boolean),
        );
        info.hidden = false;
    }

    function unitDetails(u) {
        const bar = (value, max, label) =>
            h(
                'span',
                {
                    class: 'meter',
                    role: 'meter',
                    'aria-valuemin': '0',
                    'aria-valuemax': String(max),
                    'aria-valuenow': String(value),
                    'aria-label': label,
                },
                h('span', { style: `width:${(100 * value) / max}%` }),
            );
        return h(
            'dl',
            { class: 'unit-details' },
            h('dt', {}, 'Faction'),
            h('dd', {}, getMap().factions[u.faction].name),
            h('dt', {}, 'Size'),
            h('dd', {}, `${u.size} / ${UNITS.maxSize} battalions`),
            h('dt', {}, 'Strength'),
            h('dd', {}, bar(u.strength, UNITS.maxStrength, 'Strength'), ` ${u.strength}%`),
            h('dt', {}, 'Motivation'),
            h('dd', {}, bar(u.motivation, 1, 'Motivation'), ` ${Math.round(u.motivation * 100)}%`),
            h('dt', {}, 'Moves today'),
            h('dd', {}, movesLeft(u) ? `${movesLeft(u)} left` : 'Already moved (back tomorrow)'),
        );
    }

    return {
        selectUnit,
        selectProvince,
        clear,
        refresh,
        reset: () => {
            selection = [];
            mode = null;
            province = null;
        },
    };
}
