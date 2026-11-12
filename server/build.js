/**
 * @file Build information: version, commit and environment.
 *
 * The version has a single source of truth, package.json (bump it with
 * `npm version <patch|minor|major>`, which also creates the matching git tag).
 * The commit comes from BUILD_COMMIT when set (CI / hosting), otherwise from
 * the local git checkout; it is null when neither is available.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

function gitCommit() {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch {
        return null;
    }
}

/**
 * @typedef {object} BuildInfo
 * @property {string} version Semantic version from package.json.
 * @property {string|null} commit Short commit hash, if known.
 * @property {string} env NODE_ENV, defaults to "development".
 * @property {string} builtAt ISO date the server started.
 */

/** @type {Readonly<BuildInfo>} */
export const BUILD = Object.freeze({
    version: pkg.version,
    commit: process.env.BUILD_COMMIT?.slice(0, 7) || gitCommit(),
    env: process.env.NODE_ENV || 'development',
    builtAt: new Date().toISOString(),
});
