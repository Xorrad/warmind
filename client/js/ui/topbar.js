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
