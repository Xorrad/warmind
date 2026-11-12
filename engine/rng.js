/**
 * @file Seeded random number generator.
 *
 * The whole engine must be deterministic: the same seed always produces the
 * same map and the same battle outcomes, so a campaign can be rebuilt and
 * tested. Never use Math.random() inside engine/.
 */

/**
 * Hash a string into a 32-bit unsigned integer (FNV-1a).
 * @param {string} str
 * @returns {number}
 */
export function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/**
 * @typedef {object} Rng
 * @property {() => number} next Float in [0, 1).
 * @property {(min: number, max: number) => number} range Float in [min, max).
 * @property {(min: number, max: number) => number} int Integer in [min, max] (inclusive).
 * @property {<T>(arr: T[]) => T} pick Random element of an array.
 * @property {<T>(arr: T[]) => T[]} shuffle Shuffled copy of an array.
 * @property {(p: number) => boolean} chance True with probability p.
 */

/**
 * Create a seeded pseudo-random generator (mulberry32).
 * @param {string|number} seed
 * @returns {Rng}
 */
export function createRng(seed) {
    let a = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));

    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    return {
        next,
        range: (min, max) => min + next() * (max - min),
        int: (min, max) => Math.floor(min + next() * (max - min + 1)),
        pick: (arr) => arr[Math.floor(next() * arr.length)],
        shuffle(arr) {
            const copy = [...arr];
            for (let i = copy.length - 1; i > 0; i--) {
                const j = Math.floor(next() * (i + 1));
                [copy[i], copy[j]] = [copy[j], copy[i]];
            }
            return copy;
        },
        chance: (p) => next() < p,
    };
}
