# WarMind: Development Plan

> Assumed deadline: presentations around **Dec 10–12, 2026** (the brief says 2025, but your plan is dated 2026/2027). That leaves **about 4 weeks, working solo**. The plan is sized for that.

---

## 0. Scope: what must be in the demo vs. what can be dropped

| Priority | Feature | Why |
|---|---|---|
| **MVP** | Todo list (add / complete / delete; priority, severity, due date) | Core of the concept |
| **MVP** | Daily points computed from the todo list, with a penalty for overdue tasks | Links tasks to the game |
| **MVP** | Generated map of irregular provinces with terrain, ownership and selection | Main visual element |
| **MVP** | Units plus the actions Move, Attack, Strengthen, Merge, Split | The game itself |
| **MVP** | Combat resolution plus a simple AI for enemy factions | Without these, nothing happens on the map |
| **MVP** | Accounts (register/login) and a saved campaign on a server | Your plan requires a centralized app |
| **MVP** | Deployed online | Part of the grading (Deployment section) |
| Should | Streaks panel (recurring daily tasks, entered manually) | Visible in the UI mockup |
| Should | Relocate, Ceasefire | Fairly cheap once the others work |
| Should | Responsive mobile layout | You already have a mobile mockup |
| Stretch | Real **integrations** (Anki, Duolingo, …) | Often there's no public API, or the app is local-only (AnkiConnect). High risk, so treat it as a bonus |
| Stretch | Unit motivation driven by streaks, history flavour text, events | Polish |

**Rule:** don't start any Stretch feature until the MVP is deployed.

---

## 1. Tech stack (all choices need a justification in your working document)

| Layer | Choice | Justification |
|---|---|---|
| Front-end | **Vanilla JS (ES modules) + HTML + CSS** | Required by the brief; no framework to learn or defend |
| Map rendering | **SVG** (one `<path>` per province) | Native click/hover events, CSS styling, stays sharp at any zoom |
| Map generation | **d3-delaunay** (Voronoi) + Lloyd relaxation + a seeded RNG | Produces the irregular "cells" from the mockup, and province adjacency comes from the Delaunay neighbours |
| Back-end | **Node.js + Express** | Same language everywhere; small surface |
| Database | **SQLite** (`better-sqlite3`) | No DB server; one file; enough for this project |
| Auth | Sessions (`express-session`) + **bcrypt** password hashing | Simplest secure option; avoids getting JWT wrong |
| Tests | **Vitest** (or `node --test`) on the game engine | The engine is pure logic, so it's easy to test |
| Docs | **JSDoc** comments → generated HTML docs | Answers the brief's question about generated vs. mixed documentation |
| Lint/format | ESLint + Prettier | Code quality |
| Deployment | **Render / Railway / Fly.io** (Node + a persistent volume for SQLite), or a department/personal VPS | See section 6 |
| AI | Claude Code (code), an image model for the logo/textures/mockups | Write these down as you go, for the "AI Used" section |

Alternative if the back-end slips: **PocketBase** or **Supabase** give you auth + DB with almost no code. Keep this as a fallback, not plan A.

---

## 2. Architecture

The key idea, which also answers "do you separate the interface from the code?": the **game engine is pure JS with no DOM and no network calls**. The UI only reads state and sends actions to it.

```
warmind/
├── client/
│   ├── index.html
│   ├── css/
│   │   ├── base.css          # variables, colours, typography
│   │   ├── layout.css        # top bar / side panel / map grid
│   │   └── components.css    # cards, popups, buttons
│   ├── assets/               # logo, icons, textures
│   └── js/
│       ├── main.js           # bootstrap: login check → load campaign → render
│       ├── api.js            # fetch wrappers (auth, campaign, tasks)
│       ├── store.js          # current state + subscribe/notify
│       └── ui/
│           ├── topbar.js     # logo, action points, settings
│           ├── tasks.js      # Todo / Streaks / Completed panels
│           ├── map.js        # SVG rendering, selection, highlights
│           ├── actions.js    # action bar (bottom right)
│           └── modals.js     # add task, settings, attack confirm…
├── engine/                   # PURE logic, shared by client & server
│   ├── rng.js                # seeded random
│   ├── mapgen.js             # Voronoi provinces, terrain, adjacency, factions
│   ├── points.js             # daily points from tasks
│   ├── units.js              # merge / split / strengthen
│   ├── combat.js             # battle resolution
│   ├── actions.js            # validate + apply each action (cost, rules)
│   ├── ai.js                 # enemy faction turns
│   └── tick.js               # daily turn: points, AI, motivation
├── server/
│   ├── index.js              # Express app, static files, routes
│   ├── db.js                 # SQLite schema + queries
│   ├── auth.js               # register / login / logout / middleware
│   └── routes/
│       ├── campaign.js
│       └── tasks.js
├── tests/                    # engine unit tests
├── docs/                     # generated JSDoc + working document assets
└── README.md
```

### Data model (first draft)

- **users**: id, username, password_hash, created_at
- **campaigns**: id, user_id, seed, state_json, last_tick_date
- **tasks**: id, user_id, title, priority, severity (1–5), due_at, recurring (bool), completed_at, created_at

Storing the game state as **one JSON blob per campaign** keeps the back-end tiny, and the engine owns the structure:

```js
state = {
  day, seed,
  provinces: [{ id, name, terrain, owner, neighbours: [] , polygon }],
  factions:  [{ id, name, color, isPlayer, actionPoints, ceasefires: {} }],
  units:     [{ id, faction, province, size, strength, motivation }],
  log:       [ /* battle and event messages */ ]
}
```

### The daily tick

Don't use a cron job. When the user loads the campaign, the server computes how many days have passed since `last_tick_date` and runs `tick()` once for each. This is simple, works on free hosting that goes to sleep, and is deterministic.

---

## 3. Game rules: pin down the numbers (week 1)

Your plan describes the rules without any formulas. Choose starting values, put them in `engine/config.js`, and tune them later:

- **Daily points:** `max = BASE + PER_PROVINCE × provincesOwned`
  - for each unfinished task: `max -= severity × urgency`, where `urgency = clamp(1 − daysLeft/7, 0.2, 1)`
  - any overdue unfinished task → `max = 0` (as your design says)
  - an empty todo list should not be the best strategy. Consider a small bonus for each task completed that day.
- **Action costs:** Move 1, Attack 3, Strengthen 2, Merge 1, Split 1, Relocate 4, Ceasefire 5.
- **Combat:** `power = size × strength × (0.5 + motivation) × terrainMod`; winner = higher power × random(0.85–1.15); losses proportional to the power ratio; the loser retreats to an owned neighbour or is destroyed if it has none or its size/strength falls under a threshold.
- **Terrain:** plains (1.0 attack, 1 move), forest (0.8 attack / 1.2 defence), mountains (0.6 / 1.5, 2 move), cities (defence 1.3).
- **AI:** each enemy faction gets points like the player (base + provinces). Greedy strategy: attack the weakest adjacent enemy province where its odds are above 60%, otherwise strengthen or merge.

Write these formulas into the working document; they make good material for the oral.

---

## 4. Schedule

| Dates | Phase | Deliverables |
|---|---|---|
| **Nov 12 – 15** | Setup | Git repo (main/dev), folder structure, ESLint/Prettier/Vitest, Express serving `client/`, **a "hello world" deployed online** (deploy early to remove that risk), formulas from section 3 |
| **Nov 16 – 22** | Engine + static UI | `mapgen` (Voronoi, terrain, neighbours, 4–6 factions), SVG map rendering with hover/select, layout from `ui_pc2.png` (top bar, 3 side panels, action bar), todo list in local state, `points.js` + tests |
| **Nov 23 – 29** | Gameplay | Units drawn on the map, actions Move/Attack/Strengthen/Merge/Split with costs, `combat.js` + tests, `ai.js`, `tick.js`, event log; game fully playable with localStorage saves |
| **Nov 30 – Dec 6** | Back-end + deploy | SQLite schema, auth (register/login pages), campaign + task API, save/load replaces localStorage, server-side tick on load, production deployment, mobile layout, Streaks panel |
| **Dec 7 – 9** | Finalise | Feature freeze on `main`, bug fixes, demo account with a pre-seeded campaign, generated JSDoc, finish the working document, slides/oral rehearsal |
| buffer | — | Ceasefire/Relocate, integrations, polish, only if everything above is done |

**Checkpoint rule:** if gameplay is not playable by **Nov 29**, simplify combat and the AI rather than pushing the back-end later.

---

## 5. Git workflow

- `main`: always deployable; what the jury sees. Only merges from `dev`, tagged (`v0.1.0`, `v1.0.0`, …), matching the version shown next to the logo.
- `dev`: integration branch.
- `feature/<name>` (e.g. `feature/mapgen`, `feature/combat`, `feature/auth`): one per feature, merged into `dev` with a merge request on the department GitLab, even when working alone (it leaves a trace you can show).
- Commit convention: **Conventional Commits** (`feat:`, `fix:`, `docs:`, `test:`…).
- Optional: GitLab CI running `npm test` + lint on each push, and a deploy hook on `main`. This gives you a direct answer to "how do you connect development and deployment?".

---

## 6. Deployment

- **Target:** the web (responsive), so it works on PC and smartphone without any install. Justification: centralized accounts, the brief asks for HTML/JS/CSS, and there are no app stores involved. Optionally add a PWA manifest so it can be installed on a phone home screen.
- **Hosting:** one Node service that serves the static client and the API from the same origin (no CORS problems), with SQLite on a **persistent volume**. Watch out: free tiers with ephemeral disks wipe SQLite on every redeploy.
- **Pipeline:** push to `main` → CI tests → host auto-deploys.
- **Config:** `.env` for `SESSION_SECRET`, `DB_PATH`, `PORT`; never commit it.
- **Likely difficult points** (worth writing up for the "points difficiles" section): Voronoi map generation and adjacency, balancing the points formula, timezones/day boundaries for the tick, data persistence on free hosting.

---

## 7. The working document (`plan.odt`) as you go

Fill it in during each phase, not at the end:

- **Création**: already mostly written; complete the "AI Used" section (keep a log: tool, what for, prompt example, what you kept or rejected).
- **Design**: add the mockups (`ui_pc1`, `ui_pc2`, `ui_mobile1`), the colour palette, a list of screens/popups, and later real screenshots next to the mockups.
- **Développement**: stack table (section 1), folder tree (section 2), data model, formulas (section 3), tests, JSDoc, Git branches (section 5).
- **Déploiement**: section 6 plus the problems you actually hit and how you solved them.

---

## 8. Immediate next steps (today)

1. `git init`, create the GitLab project, and push `main` + `dev`.
2. `npm init`, install `express better-sqlite3 bcrypt express-session d3-delaunay` and dev dependencies `vitest eslint prettier jsdoc`.
3. Create the folder structure from section 2.
4. Build a prototype of `mapgen.js` and render it as SVG; this is the most visual and the riskiest piece of the front-end.
