/**
 * @file Torn paper edges.
 *
 * Every sheet (folders, task slips, cards, popups) and every button gets an
 * irregular outline: a clip-path polygon, in pixels, set on the element as
 * the --tear custom property and used by its ::before (the paper itself,
 * see .sheet in base.css). Outlines follow the element's size (resize
 * observer) and are seeded by its content, so a slip keeps its shape when
 * the list is redrawn. New elements are picked up as they appear.
 */

/** What becomes paper, and how rough its edges are. */
const KINDS = [
    // Large sheets lying on the table, under the top bar and the folders
    {
        selector: '.topbar, .sidebar',
        amplitude: 4,
        step: 14,
        corner: 12,
    },
    {
        selector:
            '.panel, .task, .province-info, .action-bar, .points-popover, .toast, .modal, .battle-side, .auth-card, .points, .session-badge',
        amplitude: 3,
        step: 9,
        corner: 7,
    },
    {
        selector:
            '.action, .modal-actions button, .shortcuts button, .dev-controls button, .logout, .session-skip, .auth-form button.primary, .auth-tabs button, .view-toggle, .count, .gain-badge, .streak-badge, .save-status',
        amplitude: 1.6,
        step: 6,
        corner: 3,
    },
];
const SELECTOR = KINDS.map((k) => k.selector).join(', ');
/** Parts of a folder's head: its outline rises into a tab around each (title, buttons). */
const TABS = ':scope > .panel-head > h2, :scope > .panel-head > .panel-actions';

/** Small seeded generator (mulberry32), so a given element tears the same way every time. */
function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}

/**
 * An irregular outline for a w×h box: points every `step` px along each
 * edge, pushed inwards by up to `amplitude` px, with worn (cut) corners.
 * With `tabs` ([{ x0, x1 }], left to right), the top edge starts `tabHeight`
 * px down and rises into a folder tab between each x0 and x1.
 * @returns {string} A clip-path polygon().
 */
export function tornOutline(w, h, { amplitude, step, corner }, seed, tabs = [], tabHeight = 0) {
    const rand = random(seed);
    const pts = [];
    const cut = () => 1 + rand() * corner;
    const top = tabs.length ? tabHeight : 0;
    // Walk a straight segment, pushing each point inwards along (nx, ny)
    const walk = (x0, y0, x1, y1, nx, ny, first = true) => {
        const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
        for (let i = first ? 0 : 1; i <= n; i++) {
            // Uneven spacing too, so the edge does not look like a saw
            const t = Math.min(1, Math.max(0, (i + (i && i < n ? (rand() - 0.5) * 0.6 : 0)) / n));
            const d = rand() * amplitude;
            pts.push([x0 + (x1 - x0) * t + nx * d, y0 + (y1 - y0) * t + ny * d]);
        }
    };
    // Top edge, left to right (through the tabs), then right, bottom, left
    let x = cut();
    let first = true;
    for (const tab of tabs) {
        const x0 = Math.max(x, tab.x0);
        const x1 = Math.min(w - 2, tab.x1);
        const slant = Math.min(7, (x1 - x0) / 4);
        if (x0 > x) walk(x, top, x0, top, 0, 1, first);
        walk(x0, top, x0 + slant, 0, 0, 1, first && x0 <= x);
        walk(x0 + slant, 0, x1 - slant, 0, 0, 1, false);
        walk(x1 - slant, 0, x1, top, 0, 1, false);
        x = x1;
        first = false;
    }
    walk(x, top, w - cut(), top, 0, 1, first);
    walk(w, top + cut(), w, h - cut(), -1, 0);
    walk(w - cut(), h, cut(), h, 0, -1);
    walk(0, h - cut(), 0, top + cut(), 1, 0);
    return `polygon(${pts.map(([px, py]) => `${px.toFixed(1)}px ${py.toFixed(1)}px`).join(', ')})`;
}

const kindOf = (el) => KINDS.find((k) => el.matches(k.selector));

function tear(el) {
    const kind = kindOf(el);
    if (!kind) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (!w || !h) return;
    // The paper (::before) is placed against the element: anchor it, unless
    // the element is already positioned (absolute cards, fixed dialogs)
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const parts = [...el.querySelectorAll(TABS)];
    const tabs = parts.map((p) => ({ x0: p.offsetLeft, x1: p.offsetLeft + p.offsetWidth }));
    const tabHeight = Math.max(0, ...parts.map((p) => p.offsetTop + p.offsetHeight));
    const size = `${w}x${h}|${tabs.map((t) => `${t.x0},${t.x1}`).join(';')}|${tabHeight}`;
    if (el.dataset.tornSize === size) return;
    el.dataset.tornSize = size;
    el.classList.add('sheet');
    // Seeded by the class and the start of the text (not the counts), so a
    // sheet keeps its edges when redrawn
    const seed = hash(`${el.className.replace(/\bsheet\b/, '')}|${(el.textContent ?? '').replace(/\d+/g, '').slice(0, 60)}`);
    el.style.setProperty('--tear', tornOutline(w, h, kind, seed, tabs, tabHeight));
}

/**
 * Turn every matching element into torn paper, now and as the page changes.
 * @param {ParentNode} [root]
 */
export function setupPaper(root = document) {
    const resize = new ResizeObserver((entries) => {
        for (const e of entries) tear(e.target.matches('.panel-head > *') ? e.target.closest('.panel') : e.target);
    });
    const watch = (el) => {
        if (el.dataset.paper) return;
        el.dataset.paper = '1';
        tear(el);
        resize.observe(el);
        for (const part of el.querySelectorAll(TABS)) resize.observe(part);
    };
    const scan = (node) => {
        if (!(node instanceof Element)) return;
        if (node.matches(SELECTOR)) watch(node);
        for (const el of node.querySelectorAll(SELECTOR)) watch(el);
    };
    scan(root instanceof Document ? root.documentElement : root);
    new MutationObserver((records) => {
        for (const r of records) for (const node of r.addedNodes) scan(node);
    }).observe(root instanceof Document ? root.documentElement : root, { childList: true, subtree: true });
}
