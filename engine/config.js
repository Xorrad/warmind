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
    provinceCount: 200,
    factionCount: 5,
    /** Lloyd relaxation passes: more = more regular province sizes. */
    relaxIterations: 1,
    /** Border wobble, as a fraction of the edge length. */
    borderJitter: 0.35,
    /** Midpoint-displacement subdivisions per border edge (2^depth segments). */
    borderDepth: 5,
    /**
     * Share of the wobble kept at each finer subdivision (0..1). Low = a few
     * smooth bulges; high = rough, detailed borders.
     */
    borderRoughness: 0.6,
    /** Fraction of provinces per terrain (the rest is plains, capitals become cities). */
    terrainShare: { mountains: 0.1, hills: 0.2, forest: 0.25 },
    /**
     * Impassable mountain ranges: thin winding provinces laid along province
     * borders. They cut adjacency between the provinces on either side.
     * Length is counted in Voronoi edges; width is in map pixels.
     */
    ranges: { count: 3, minEdges: 4, maxEdges: 8, width: 22 },
};

/**
 * Terrain types. attack/defense multiply combat power, moveCost is the
 * number of action points needed to enter the province. Impassable terrain
 * (passable: false) can never be entered or garrisoned.
 */
export const TERRAINS = {
    plains: { label: 'Plains', color: '#d8d0a0', attack: 1.0, defense: 1.0, moveCost: 1, passable: true },
    forest: { label: 'Forest', color: '#8fae7e', attack: 0.8, defense: 1.2, moveCost: 1, passable: true },
    hills: { label: 'Hills', color: '#c2a57b', attack: 0.9, defense: 1.25, moveCost: 1, passable: true },
    mountains: { label: 'Mountains', color: '#9b918a', attack: 0.6, defense: 1.5, moveCost: 2, passable: true },
    city: { label: 'City', color: '#c8c0c8', attack: 1.0, defense: 1.3, moveCost: 1, passable: true },
    range: { label: 'Mountain range', color: '#5e5650', passable: false },
};

/**
 * Daily action points. Each day a faction gets
 *   base + perProvince × provinces owned
 * minus, for every unfinished task, severity × urgency, where
 *   urgency = clamp(1 − daysLeft / urgencyWindowDays, minUrgency, 1)
 * plus completionBonus per task completed that day (up to completionBonusCap).
 * Any overdue unfinished task sets the whole amount to zero.
 */
export const POINTS = {
    base: 5,
    perProvince: 0.2,
    urgencyWindowDays: 7,
    minUrgency: 0.2,
    completionBonus: 1,
    completionBonusCap: 5,
};

/** Task fields: allowed values. */
export const TASKS = {
    severity: { min: 1, max: 5 },
    titleMaxLength: 120,
    /** Days of history kept for recurring (streak) tasks. */
    historyDays: 400,
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
