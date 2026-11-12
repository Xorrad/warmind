/**
 * @file Tiny DOM helper. User text always goes through textContent.
 */

/**
 * Create an element: h('li', { class: 'x', onclick: fn }, 'text', child).
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node|string|null|false|undefined)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
}
