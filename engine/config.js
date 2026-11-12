/**
 * @file Tunable game constants (points, costs, terrain modifiers).
 *
 * Every balancing number lives here so the rules can be tuned without
 * touching the logic.
 */

/** Map generation parameters. */
export const MAP = {
    width: 1600,
    height: 1000,
    provinceCount: 70,
    factionCount: 5,
    /** Lloyd relaxation passes: more = more regular province sizes. */
    relaxIterations: 2,
    /** Border wobble, as a fraction of the edge length. */
    borderJitter: 0.2,
    /** Midpoint-displacement subdivisions per border edge. */
    borderDepth: 3,
    /** Fraction of provinces per terrain (the rest is plains, capitals become cities). */
    terrainShare: { mountains: 0.1, hills: 0.2, forest: 0.25 },
};

/**
 * Terrain types. attack/defense multiply combat power, moveCost is the
 * number of action points needed to enter the province.
 */
export const TERRAINS = {
    plains: { label: 'Plains', color: '#d8d0a0', attack: 1.0, defense: 1.0, moveCost: 1 },
    forest: { label: 'Forest', color: '#8fae7e', attack: 0.8, defense: 1.2, moveCost: 1 },
    hills: { label: 'Hills', color: '#c2a57b', attack: 0.9, defense: 1.25, moveCost: 1 },
    mountains: { label: 'Mountains', color: '#9b918a', attack: 0.6, defense: 1.5, moveCost: 2 },
    city: { label: 'City', color: '#c8c0c8', attack: 1.0, defense: 1.3, moveCost: 1 },
};

/** Faction identities. Index 0 is always the player. */
export const FACTIONS = [
    { name: 'Provisional Government', color: '#3b6fb6' },
    { name: 'Royalist League', color: '#b8433b' },
    { name: "People's Council", color: '#d1a03a' },
    { name: 'Northern Coalition', color: '#5c8f4a' },
    { name: 'Free Army', color: '#7b5aa6' },
    { name: 'Southern Directorate', color: '#3a9a9a' },
];

/** Syllables for generated province names. */
export const NAME_PARTS = {
    start: ['Al', 'Bel', 'Cor', 'Dra', 'El', 'Fen', 'Gar', 'Hal', 'Ist', 'Kar', 'Lor', 'Mar', 'Nor', 'Ost', 'Pra', 'Rav', 'Sal', 'Tor', 'Val', 'Zar', 'Brest', 'Vel', 'Kos', 'Lin'],
    middle: ['', '', 'a', 'e', 'i', 'o', 'an', 'en', 'or', 'ar', 'el'],
    end: ['burg', 'grad', 'ia', 'mont', 'dor', 'heim', 'ova', 'stad', 'ford', 'lin', 'mir', 'vik', 'port', 'is', 'avia', 'enza'],
};
