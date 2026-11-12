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
    /**
     * Impassable seas: share of the cells flooded (low ground near the map
     * edges first), merged into sea provinces of minCells to maxCells cells.
     */
    seas: { share: 0.12, minCells: 2, maxCells: 3 },
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
    /** overlay: drawn on top of the borders it follows instead of as a tile. */
    range: { label: 'Mountain range', color: '#5e5650', passable: false, overlay: true },
    sea: { label: 'Sea', color: '#8fb3d3', passable: false },
};

/**
 * Daily action points. Each day a faction gets
 *   base = base + perProvince × provinces owned
 * minus, for every unfinished task, severity × elapsed / total, where
 *   elapsed = time since the task was created, total = creation to due date
 *   (daily tasks run over their day, so they cost their full severity by
 *   midnight). The sum of these losses is capped at maxPenaltyShare × base:
 *   above it, every task's loss is scaled down in proportion.
 * plus completionBonus per task completed that day (up to completionBonusCap).
 * Any overdue unfinished task sets the whole amount to zero.
 */
export const POINTS = {
    base: 5,
    perProvince: 0.2,
    maxPenaltyShare: 0.9,
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

/**
 * Units. size counts battalions; strength is the state of their equipment
 * (0 to 100); motivation goes from 0 to 1. Each faction starts with one unit
 * on its capital plus one per provincesPerUnit provinces, placed on its
 * borders first. A unit can move or attack movesPerDay times a day.
 */
export const UNITS = {
    maxSize: 12,
    movesPerDay: 1,
    minSplitSize: 2,
    maxStrength: 100,
    strengthenAmount: 25,
    start: { capitalSize: 3, size: 2, strength: 70, motivation: 0.5 },
    provincesPerUnit: 8,
};

/**
 * Action point cost of each action. Moving costs move × the terrain's
 * moveCost of the destination (mountains count double). An attack costs
 * attack, plus attackExtraUnit for each unit beyond the first.
 */
export const ACTION_COSTS = {
    move: 1,
    attack: 3,
    attackExtraUnit: 1,
    strengthen: 2,
    merge: 1,
    split: 1,
    relocate: 4,
    ceasefire: 5,
};

/**
 * Combat. Each unit's power = size × strength/100 × (0.5 + motivation) ×
 * terrain modifier (attack for attackers, defense for defenders, both from
 * the attacked province, softened: 1 + (modifier − 1) × terrainWeight).
 * Attackers add up their powers and get attackBonus (the initiative);
 * defenders add up theirs and get defenseBonus (dug in). Each side's total
 * is multiplied by a random
 * roll; the higher result wins. With ratio = winner / loser rolled power:
 *   loser loses strengthLoss × ratio strength and loserSizeLoss × ratio of
 *   its battalions; the winner loses strengthLoss / ratio and
 *   winnerSizeLoss / ratio (each share capped at maxSizeLoss).
 * Units left under minStrength strength or 0 battalions are destroyed;
 * beaten defenders retreat to a neighbouring province of theirs, or are
 * destroyed when there is none.
 */
export const COMBAT = {
    roll: [0.6, 1.4],
    attackBonus: 1.2,
    defenseBonus: 1.2,
    terrainWeight: 0.5,
    strengthLoss: 20,
    loserSizeLoss: 0.2,
    winnerSizeLoss: 0.08,
    maxSizeLoss: 0.6,
    minStrength: 10,
    motivationWin: 0.05,
    motivationLoss: 0.1,
};

/**
 * Enemy factions. Each settled day, every AI faction earns
 *   (base + perProvince × provinces owned) × incomeFactor
 * action points (POINTS values; savings capped at maxSavingsDays of income)
 * and spends them greedily: attacks with at least minOdds chance of
 * victory first, then resupplies front units under strengthenBelow,
 * merges small units, and moves rear units towards the front.
 */
export const AI = {
    incomeFactor: 1,
    maxSavingsDays: 3,
    minOdds: 0.6,
    strengthenBelow: 60,
    mergeUpTo: 6,
    maxActions: 12,
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
