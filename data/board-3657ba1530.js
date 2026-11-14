/* PAC TRAC · Board
   Build a board, give the Pokémon items, set the synergies, and run the fight with the game's own code.
   Loaded by the site's #board page when someone opens it; it uses the page's own helpers (esc, nameOf, spr,
   battleLibrary, sceneKit, loadStageData, loadMonData, loadPhaser...). */
"use strict";
(function () {

/* ================================================================ the fight (the game's own code) ================
   The game's server code for a fight (game_engine.json, from game_animations.py) runs in the page: each Pokémon is
   the game's PokemonEntity with its states (idle, moving, attacking), statuses, items and synergy effects, and the
   fight is the game's Simulation, minus what a fight on a server needs (the room, players' money...). Everything it
   tells the players (damage, heals, casts...) is written down with when it happened, and so is where everyone is,
   with their HP, PP and statuses, every tick. */
const TICK = 1000 / 30;                 // ms of fight per step (the game's server runs at about 60 a second)
const FIGHT_LIMIT = 45000;              // the game's FIGHTING_PHASE_DURATION
const BLUE = "BLUE_TEAM", RED = "RED_TEAM";  // (the game's enums are their members' names on the page)
const STATUS_KEYS = ["burn", "poisonStacks", "sleep", "silence", "fatigue", "freeze", "confusion", "wound", "paralysis",
  "armorReduction", "charm", "flinch", "protect", "runeProtect", "locked", "blinded", "curse", "possessed", "resurrection",
  "pokerus"];

let ENGINE = null;
// The game's fight code, ready to run, with the Pokémon data it looks things up in
function engine(SD, ED, P) {
  if (ENGINE) return ENGINE;
  const dex = P.dex;
  const passives = ED.engine.passives || {};
  const lines = {};
  for (const [name, d] of Object.entries(dex)) (lines[d.f] ||= []).push(name);
  Object.values(lines).forEach(line => line.sort((a, b) => dex[a].s - dex[b].s));
  const pokemonData = name => {
    const d = dex[name];
    if (!d) return undefined;
    const line = lines[d.f] || [name];
    const next = line[line.indexOf(name) + 1];
    return { name, index: d.i, rarity: d.r, stars: d.s, types: [...d.t], hp: d.st.hp, atk: d.st.atk, def: d.st.def,
      speDef: d.st.spedef, speed: d.st.speed, range: d.st.range, maxPP: d.st.pp, skill: d.a, passive: passives[name] || "NONE",
      additional: d.add, regional: d.reg, evolution: next || "DEFAULT", evolutions: next ? [next] : [], stages: line.length };
  };
  const byName = (map, fallback) => new Proxy(map, { get: (t, k) => typeof k !== "string" ? undefined : k in t ? t[k] : fallback(k) });
  const own = battleLibrary(SD).loadEngine(ED.engine, {
    getPokemonData: pokemonData,
    PkmFamily: byName(Object.fromEntries(Object.entries(dex).map(([n, d]) => [n, d.f])), k => k),
    PkmIndex: byName(Object.fromEntries(Object.entries(dex).map(([n, d]) => [n, d.i])), () => "0000"),
    PkmByIndex: byName(Object.fromEntries(Object.entries(dex).map(([n, d]) => [d.i, n])), () => "DEFAULT"),
    // summons and spawns: a new Pokémon from the same data
    PokemonFactory: { createPokemonFromName: name => boardPokemon({ id: `spawn-${Math.random().toString(36).slice(2)}`, name, x: 0, y: 0 }) },
    // a species as it comes out of the shop (items and passives look up its own types and stats)
    PokemonClasses: new Proxy({}, { get: (t, name) => typeof name !== "string" ? undefined
      : function (n) { return boardPokemon({ id: "species", name: n || name, x: 0, y: 0 }); } }),
    BasculinWhite: class { static [Symbol.hasInstance](p) { return p?.name === "BASCULIN_WHITE"; } },
    PRECOMPUTED_POKEMONS_PER_TYPE: Object.entries(dex).reduce((acc, [n, d]) => {
      d.t.forEach(t => (acc[t] ||= []).push(n));
      return acc;
    }, {}),
    // each type's Pokémon by how they show up: the shop's, the additional picks, regionals, uniques, legendaries...
    PRECOMPUTED_POKEMONS_PER_TYPE_AND_CATEGORY: Object.entries(dex).reduce((acc, [n, d]) => {
      const category = d.add ? "additionalPokemons" : d.reg ? "regionalPokemons" : d.r === "UNIQUE" ? "uniquePokemons"
        : d.r === "LEGENDARY" ? "legendaryPokemons" : d.r === "SPECIAL" || d.r === "HATCH" ? "specialPokemons" : "pokemons";
      d.t.forEach(t => (acc[t] ||= { pokemons: [], additionalPokemons: [], regionalPokemons: [], uniquePokemons: [],
        legendaryPokemons: [], specialPokemons: [] })[category].push(n));
      return acc;
    }, {}),
    PRECOMPUTED_POKEMONS_PER_RARITY: Object.entries(dex).reduce((acc, [n, d]) => {
      (acc[d.r] ||= []).push(n);
      return acc;
    }, { COMMON: [], UNCOMMON: [], RARE: [], EPIC: [], ULTRA: [], UNIQUE: [], LEGENDARY: [], SPECIAL: [], HATCH: [] }),
  });
  // A Pokémon as it stands on a player's board before the fight (the game's Pokemon model), from a board unit
  const boardPokemon = unit => {
    const d = dex[unit.name] || dex[Object.keys(dex)[0]];
    const stats = { ...baseStats(d), ...(unit.stats || {}) };
    const m = {
      id: unit.id, name: unit.name, index: d.i, rarity: d.r, stars: unit.stars || d.s || 1,
      types: new own.SetSchema(d.t), items: new own.SetSchema(unit.items || []), skill: unit.ability || d.a,
      passive: unit.passive ?? passives[unit.name] ?? "NONE",
      hp: stats.hp, maxHP: stats.hp, atk: stats.atk, def: stats.def, speDef: stats.spedef, speed: stats.speed,
      range: stats.range, maxPP: stats.pp, ap: stats.ap || 0, luck: stats.luck || 0, shiny: false, emotion: "Normal",
      stacks: 0, stacksRequired: 0, tm: null, positionX: unit.x, positionY: unit.y + 1, dishes: new Set(), meal: "",
      supercharged: false, hasEvolution: Boolean(pokemonData(unit.name)?.evolutions.length), canBeSold: true,
      onSpawn() {}, beforeSimulationStart() {},
    };
    return new Proxy(m, { get: (t, k) => k in t ? t[k] : typeof k === "string" ? nothing : undefined });
  };
  // What the game tells the players doesn't say who did what to whom, so the game's own damage, heal and cast
  // functions write it down too while a fight runs (into `ENGINE.log`)
  const state = own.PokemonState.prototype, entity = own.PokemonEntity.prototype;
  const { handleDamage, handleHeal } = state, { broadcastAbility } = entity;
  state.handleDamage = function (params) {
    const result = handleDamage.call(this, params);
    if (ENGINE.log && result && (result.takenDamage > 0 || result.death)) ENGINE.log("damage", { to: params.target.id,
      from: params.attacker?.id ?? null, amount: result.takenDamage, type: params.attackType, death: result.death });
    return result;
  };
  state.handleHeal = function (pokemon, heal, origin, apBoost, crit) {
    const result = handleHeal.call(this, pokemon, heal, origin, apBoost, crit);
    if (ENGINE.log && result?.healReceived > 0) ENGINE.log("heal", { to: pokemon.id, from: origin?.id ?? null, amount: Math.round(result.healReceived) });
    return result;
  };
  entity.broadcastAbility = function (args = {}) {
    if (ENGINE.log) ENGINE.log("cast", { by: this.id, skill: args.skill ?? this.skill, x: args.positionX ?? this.positionX,
      y: args.positionY ?? this.positionY, tx: args.targetX ?? this.targetX, ty: args.targetY ?? this.targetY,
      orientation: args.orientation ?? this.orientation, delay: args.delay, data: args.data, ap: args.ap ?? this.ap });
    return broadcastAbility.call(this, args);
  };
  ENGINE = { own, dex, pokemonData, boardPokemon, lines, passives, log: null };
  return ENGINE;
}

const STAT_KEYS = ["hp", "atk", "def", "spedef", "speed", "range", "pp", "ap", "critChance", "critPower", "luck", "shield"];
const baseStats = d => ({ hp: d.st.hp, atk: d.st.atk, def: d.st.def, spedef: d.st.spedef, speed: d.st.speed,
  range: d.st.range, pp: d.st.pp, ap: 0, critChance: 10, critPower: 2, luck: 0, shield: 0 });

// The effects a team's synergies give it in the fight: each synergy at level n gives its nth tier's effect, as
// the game's Synergies.getActiveSynergyTiers does
function teamEffects(own, levels) {
  const effects = [];
  for (const [synergy, level] of Object.entries(levels)) {
    const tiers = own.SynergyTiers[synergy] || [];
    if (level > 0 && tiers[Math.min(level, tiers.length) - 1]) effects.push(tiers[Math.min(level, tiers.length) - 1]);
  }
  return effects;
}

// Runs one fight to its end (or the game's time limit). `board` is the editor's board; `teams` each side's synergy
// levels and counts ({ blue: { levels, counts }, red: ... }). Returns where everyone was every tick (unless `record`
// is false), what happened, and the outcome.
function runFight(E, board, teams, { seed, record = true } = {}) {
  const { own } = E;
  const random = seed != null ? seededRandom(seed) : null;
  const realRandom = Math.random;
  if (random) Math.random = random;
  try {
    own.BOARD_WIDTH = board.cols;
    own.BOARD_HEIGHT = board.rows;
    own.BOARD_SIDE_HEIGHT = Math.floor(board.rows / 2);
    const events = [], frames = [], log = [];
    let clock = 0;
    const note = (transfer, data = {}) => { if (record) events.push({ t: clock, transfer, ...data }); };
    E.log = (kind, data) => log.push({ t: clock, kind, ...data });
    const room = new Proxy({ state: { time: FIGHT_LIMIT }, broadcast: note, clients: [],
      clock: { setTimeout: (fn, ms) => fight.commands.push(new own.DelayedCommand(fn, ms)) } },
      { get: (t, k) => k in t ? t[k] : typeof k === "string" ? nothing : undefined });
    const side = team => board.units.filter(u => u.team === team);
    // a player's synergies are the game's own (counts per synergy, with its active-synergy questions)
    const synergies = counts => own.Synergies ? new own.Synergies(new Map(Object.entries(counts)))
      : new own.MapSchema(Object.entries(counts));
    const player = (id, units, effects, counts) => new Proxy({
      id, name: id, board: new own.MapSchema(units.map(u => [u.id, E.boardPokemon(u)])), effects: new own.SetSchema(effects),
      synergies: synergies(counts), items: [], titles: new Set(), money: 0, life: 100,
      pokemonsPlayed: new Set(), ghost: false, isBot: false,
    }, { get: (t, k) => k in t ? t[k] : typeof k === "string" ? nothing : undefined });
    const blueEffects = teamEffects(own, teams.blue.levels), redEffects = teamEffects(own, teams.red.levels);
    const bluePlayer = player("blue", side("blue"), blueEffects, teams.blue.counts || {});
    const redPlayer = player("red", side("red"), redEffects, teams.red.counts || {});

    // The game's Simulation, set up the way its constructor does, without the server
    const fight = Object.create(own.Simulation.prototype);
    Object.assign(fight, {
      id: "board", room, bluePlayer, redPlayer, bluePlayerId: "blue", redPlayerId: "red", stageLevel: board.settings.stage,
      weather: board.settings.weather, isGhostBattle: false, board: new own.Board(board.rows, board.cols), started: false,
      finished: false, finishedAt: 0, winnerId: "", blueEffects: new Set(blueEffects), redEffects: new Set(redEffects),
      blueTeam: new own.MapSchema(), redTeam: new own.MapSchema(), blueDpsMeter: new own.MapSchema(),
      redDpsMeter: new own.MapSchema(), entities: [], commands: [], blueAbilitiesCast: [], redAbilitiesCast: [],
      blueFlowerSpawn: 0, redFlowerSpawn: 0, stormLightningTimer: 4000, tidalWaveTimer: 0, tidalWaveCounter: 0,
      reinforcementsSent: false,
    });
    fight.broadcastToSpectators = note;
    fight.onFinish = () => { fight.finished = true; };  // (the game's hands out money and Elo here)
    if (own.SynergyTiers.AQUATIC?.some(e => fight.blueEffects.has(e) || fight.redEffects.has(e))) fight.tidalWaveTimer = 7000;

    // Everyone onto the board (synergy effects, then items, then what happens when they appear), then the
    // effects that need the whole team, then the start of the fight
    const notes = [];
    const unitOf = new Map();  // entity -> the board unit it is
    for (const [team, owner] of [["blue", bluePlayer], ["red", redPlayer]]) {
      for (const unit of side(team)) {
        try {
          const entity = fight.addPokemon(owner.board.get(unit.id), unit.x, unit.y, team === "blue" ? BLUE : RED);
          unitOf.set(entity, unit.id);
          // what the editor sets beyond the game's own stats: AP and luck go in before (as the game's own Pokémon
          // carry them); the rest is put on top of what items and synergies gave
          const o = unit.stats || {};
          if (o.critChance != null) entity.critChance += o.critChance - 10;
          if (o.critPower != null) entity.critPower += o.critPower - 2;
          if (o.shield) entity.shield += o.shield;
        } catch (err) {
          notes.push(`${nameOf("pokemon", unit.name)} couldn't be put in the fight (${err.message})`);
        }
      }
    }
    try { fight.applyPostEffects(bluePlayer.board, redPlayer.board); } catch (err) { notes.push(`Team effects at the start didn't all run (${err.message})`); }
    try { fight.start(); } catch (err) { notes.push(`Start-of-fight effects didn't all run (${err.message})`); }

    const snapshot = () => frames.push({ t: clock, units: fight.entities.map(e => ({
      id: e.id, unit: unitOf.get(e) ?? null, name: e.name, index: e.index,
      team: e.team === BLUE ? "blue" : "red", x: e.positionX, y: e.positionY,
      hp: Math.max(0, Math.round(e.hp)), maxHP: Math.round(e.maxHP), shield: Math.round(e.shield), pp: Math.round(e.pp),
      maxPP: e.maxPP, action: e.action, orientation: e.orientation, skydiving: Boolean(e.status.skydiving),
      atk: Math.round(e.atk), def: Math.round(e.def), speDef: Math.round(e.speDef), speed: Math.round(e.speed),
      ap: Math.round(e.ap), range: e.range, attacks: e.count?.attackCount ?? 0, target: e.targetEntityId || null,
      alive: e.hp > 0 && (fight.blueTeam.has(e.id) || fight.redTeam.has(e.id)),
      status: Object.fromEntries(STATUS_KEYS.map(k => [k, k === "poisonStacks" ? e.status.poisonStacks || 0 : Boolean(e.status[k])])),
    })) });
    snapshot();
    const errors = [];
    while (clock < FIGHT_LIMIT && fight.blueTeam.size > 0 && fight.redTeam.size > 0) {
      clock += TICK;
      room.state.time = FIGHT_LIMIT - clock;  // the game counts the phase's time down
      try { fight.update(TICK); } catch (err) {
        if (errors.length < 3) {
          errors.push(err.stack);
          notes.push(`Something in the fight didn't run at ${(clock / 1000).toFixed(1)} s (${err.message})`);
        }
      }
      if (record) snapshot();
    }
    if (!record) snapshot();
    const winner = fight.blueTeam.size > 0 && fight.redTeam.size === 0 ? "blue"
      : fight.redTeam.size > 0 && fight.blueTeam.size === 0 ? "red" : "draw";
    // the game's damage meter (what each dealt, healed and shielded, and what armor and shields blocked), plus
    // what each took, from the log
    const taken = {};
    log.forEach(e => { if (e.kind === "damage") taken[e.to] = (taken[e.to] || 0) + e.amount; });
    const stats = fight.entities.map(e => ({ id: e.id, unit: unitOf.get(e) ?? null,
      name: e.name, index: e.index, team: e.team === BLUE || e.baseTeam === BLUE ? "blue" : "red",
      dealt: Math.round(e.physicalDamage + e.specialDamage + e.trueDamage), physical: Math.round(e.physicalDamage),
      special: Math.round(e.specialDamage), trueDamage: Math.round(e.trueDamage), taken: Math.round(taken[e.id] || 0),
      blocked: Math.round(e.physicalDamageReduced + e.specialDamageReduced), shieldTaken: Math.round(e.shieldDamageTaken),
      healed: Math.round(e.healDone), shielded: Math.round(e.shieldDone), casts: log.filter(l => l.kind === "cast" && l.by === e.id).length,
      attacks: e.count?.attackCount ?? 0, survived: e.hp > 0 && (fight.blueTeam.has(e.id) || fight.redTeam.has(e.id)) }));
    return { frames, events, log: record ? log : [], winner, duration: clock, stats, notes, errors,
      effects: { blue: blueEffects, red: redEffects } };
  } finally {
    Math.random = realRandom;
    E.log = null;
  }
}

// A repeatable random sequence (mulberry32), so a fight can be replayed exactly
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================================================================ boards: what one is, saving it ================
   A board is plain data: its size, the Pokémon on it (each with its items, and whatever the editor changed about
   it), each side's synergy settings and the fight's settings. The bottom half is the blue side, the top half red;
   y counts rows from the bottom, as the game's fight does. */
const BOARD_FORMAT = "pac-tracker-board";
const COLS = [4, 12], SIDE_ROWS = [2, 5];
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const uid = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const sideOf = (board, y) => y < board.rows / 2 ? "blue" : "red";
const blankSynergies = () => ({ mode: "auto", off: [], levels: {}, thresholds: {} });
function blankBoard(name = "New board") {
  return { format: BOARD_FORMAT, v: 1, id: uid(), name, cols: 8, rows: 6, units: [], created: Date.now(), updated: Date.now(),
    settings: { stage: 20, weather: "NEUTRAL", seed: 1, itemLimit: 3, combine: true },
    syn: { blue: blankSynergies(), red: blankSynergies() } };
}
const numbers = (obj, keys) => Object.fromEntries(Object.entries(obj && typeof obj === "object" ? obj : {})
  .filter(([k, v]) => (!keys || keys.includes(k)) && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]));

// A board as it should be, whatever it came from (an old save, a file someone edited): known Pokémon and items,
// one Pokémon a cell, everyone inside the board, numbers where numbers go
function cleanBoard(raw, known) {
  const b = blankBoard();
  if (!raw || typeof raw !== "object") return b;
  if (typeof raw.id === "string" && raw.id) b.id = raw.id.slice(0, 64);
  b.name = String(raw.name ?? "Board").trim().slice(0, 60) || "Board";
  b.created = Number(raw.created) || b.created;
  b.updated = Number(raw.updated) || b.updated;
  b.cols = clamp(Math.round(Number(raw.cols) || 8), ...COLS);
  b.rows = 2 * clamp(Math.round((Number(raw.rows) || 6) / 2), ...SIDE_ROWS);
  const s = raw.settings || {};
  b.settings = { stage: clamp(Math.round(Number(s.stage) || 20), 1, 60),
    weather: known.weathers.includes(s.weather) ? s.weather : "NEUTRAL", seed: Math.max(1, Math.round(Number(s.seed) || 1)),
    itemLimit: s.itemLimit === 0 ? 0 : 3, combine: s.combine !== false };
  for (const team of ["blue", "red"]) {
    const t = raw.syn?.[team] || {};
    b.syn[team] = { mode: t.mode === "manual" ? "manual" : "auto",
      off: Array.isArray(t.off) ? t.off.filter(x => known.synergies.includes(x)) : [],
      levels: Object.fromEntries(Object.entries(numbers(t.levels)).filter(([k]) => known.synergies.includes(k))),
      thresholds: Object.fromEntries(Object.entries(t.thresholds || {}).filter(([k, v]) => known.synergies.includes(k) && Array.isArray(v))
        .map(([k, v]) => [k, v.map(Number).filter(n => n > 0 && n < 100).sort((x, y) => x - y)]).filter(([, v]) => v.length)) };
  }
  const taken = new Set(), ids = new Set();
  for (const u of Array.isArray(raw.units) ? raw.units : []) {
    if (!u || !known.dex[u.name]) continue;
    const x = Math.round(Number(u.x)), y = Math.round(Number(u.y));
    if (!(x >= 0 && x < b.cols && y >= 0 && y < b.rows) || taken.has(`${x},${y}`)) continue;
    taken.add(`${x},${y}`);
    let id = typeof u.id === "string" && u.id ? u.id.slice(0, 64) : uid();
    if (ids.has(id)) id = uid();
    ids.add(id);
    const items = [...new Set((Array.isArray(u.items) ? u.items : []).filter(i => known.items.has(i)))];
    const unit = { id, name: u.name, x, y, team: sideOf(b, y), items: b.settings.itemLimit ? items.slice(0, b.settings.itemLimit) : items,
      stats: numbers(u.stats, STAT_KEYS) };
    if (typeof u.ability === "string" && known.abilities.has(u.ability)) unit.ability = u.ability;
    if (typeof u.passive === "string") unit.passive = u.passive;
    b.units.push(unit);
  }
  return b;
}

// After any change: everyone's side follows their row, nobody outside the board or on someone else's cell
function tidy(b) {
  const taken = new Set();
  b.units = b.units.filter(u => {
    const key = `${u.x},${u.y}`;
    if (!(u.x >= 0 && u.x < b.cols && u.y >= 0 && u.y < b.rows) || taken.has(key)) return false;
    taken.add(key);
    u.team = sideOf(b, u.y);
    return true;
  });
}

// This browser's storage. It can be missing or full (private windows, blocked site data): then nothing is kept,
// and the page still works.
const local = {
  read(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
};
const KEYS = { draft: "pacboard:draft", saves: "pacboard:saves", prefs: "pacboard:prefs" };
// Saved boards. Kept in this browser; every use goes through these calls, so an online store (the bot's, for a
// linked account) can sit behind them later without the rest changing.
const Saves = {
  all() { const all = local.read(KEYS.saves, {}); return all && typeof all === "object" ? all : {}; },
  list() { return Object.values(this.all()).filter(b => b && b.id).sort((a, b) => (b.updated || 0) - (a.updated || 0)); },
  get(id) { return this.all()[id] || null; },
  put(board) { const all = this.all(); all[board.id] = board; return local.write(KEYS.saves, all); },
  remove(id) { const all = this.all(); delete all[id]; return local.write(KEYS.saves, all); },
};
const boardKey = b => JSON.stringify({ ...b, updated: 0 });

/* ================================================================ the page ================ */
// Everything the page shows comes from S (the board being edited, its history, what's selected...), drawn by the
// render functions below; every change to the board goes through change(), which keeps the undo history.
let UI = null;
const S = {
  board: null, saved: null, history: [], future: [], selected: null, armed: null, mode: "edit", tab: "details",
  synTeam: "blue", picker: { q: "", syn: [], rarity: [], stars: [], role: "", pool: "" }, itemFilter: { q: "", group: "all" },
  result: null, bottom: "log", logFilter: "key", logLimit: 300, compare: null, focus: null,
};
const RARITY_ORDER = ["COMMON", "UNCOMMON", "RARE", "EPIC", "ULTRA", "UNIQUE", "LEGENDARY", "HATCH", "SPECIAL"];
const STAT_LABELS = { hp: "HP", atk: "Attack", def: "Defense", spedef: "Sp. Defense", speed: "Speed", range: "Range",
  pp: "Max PP", ap: "Ability power", critChance: "Crit chance %", critPower: "Crit power ×", luck: "Luck", shield: "Shield" };
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const OUTRO = 1800;  // ms of replay after the fight's last tick, for the last knockout to play out
const ICONS = {
  undo: '<path d="M4 7h7a4 4 0 0 1 0 8H8"/><path d="M7 4L4 7l3 3"/>',
  redo: '<path d="M12 7H5a4 4 0 0 0 0 8h3"/><path d="M9 4l3 3-3 3"/>',
  save: '<path d="M3 3h8l2 2v8H3z"/><path d="M5 3v3h5V3M5 13V9h6v4"/>',
  folder: '<path d="M2 4h4l1.5 1.5H14V13H2z"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  copy: '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3h8"/>',
  download: '<path d="M8 2v8M5 7l3 3 3-3M3 13h10"/>',
  upload: '<path d="M8 11V3M5 6l3-3 3 3M3 13h10"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  play: '<path d="M5 3l8 5-8 5z" fill="currentColor"/>',
  pause: '<path d="M5 3v10M11 3v10"/>',
  restart: '<path d="M3 8a5 5 0 1 0 1.5-3.5"/><path d="M3 2.5V5h2.5"/>',
  step: '<path d="M4 3l6 5-6 5z" fill="currentColor"/><path d="M12 3v10"/>',
  dice: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><circle cx="5.5" cy="5.5" r=".8" fill="currentColor"/><circle cx="10.5" cy="10.5" r=".8" fill="currentColor"/><circle cx="8" cy="8" r=".8" fill="currentColor"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  reset: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v3h3"/>',
  swap: '<path d="M4 6h9l-2.5-2.5M12 10H3l2.5 2.5"/>',
};
const icon = name => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const stars = n => n > 0 ? "★".repeat(n) : "";
const pkName = name => nameOf("pokemon", name);
const synName = s => UI.W.synergy?.[s] || nameOf("synergy", s);
const itemName = i => UI.W.item?.[i] || nameOf("item", i);
const effectName = e => UI.W.effect?.[e] || titleCase(e);
// The game's descriptions, readable: its bracketed per-level numbers and CAPITAL words as abilityText shows them
const describe = text => abilityText(String(text || "").replace(/\{\{[^}]*\}\}/g, "").replace(/\$t\((?:pkm\.)?(\w+)\)/g, (_, k) => pkName(k)), 0);
// An item's picture: from the board's own item sheet, the site's, or (for one neither has) the game's site
const itemIcon = (item, px) => D.sheets.gear?.keys[item] !== undefined ? spr("gear", item, px, itemName(item))
  : D.sheets.item.keys[item] !== undefined ? spr("item", item, px, itemName(item))
  : `<img class="pb-img" src="${GAME_SITE}/assets/item/${encodeURIComponent(item)}.png" width="${px}" height="${px}" alt="${esc(itemName(item))}" title="${esc(itemName(item))}" crossorigin="anonymous" loading="lazy" draggable="false">`;
const portraitOf = (name, px) => spr("dex", name, px, pkName(name));
const unitAt = (x, y) => S.board.units.find(u => u.x === x && u.y === y);
const unitById = id => S.board.units.find(u => u.id === id);
const fmtTime = ms => `${(ms / 1000).toFixed(1)} s`;

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the server answered ${r.status}`);
  return r.json();
}

/* ---------- start ---------- */
async function mount(host) {
  Playback.close();
  closeMenu();
  host.innerHTML = `<div class="panel empty-note">Loading the board and the game's fight code…</div>`;
  try {
    if (!D.engineData || !D.boardTexts) throw new Error("this copy of the site has no fight code");
    const [P, SD, ED, W] = await Promise.all([loadMonData(), loadStageData(), fetchJSON(D.engineData), fetchJSON(D.boardTexts)]);
    if (!host.isConnected) return;
    const E = engine(SD, ED, P);
    const own = E.own;
    const unholdable = new Set(own.UnholdableItems || []);
    const allItems = Object.keys(own.Item || {}).filter(i => !unholdable.has(i) && i !== "DEFAULT");
    const recipes = {};
    for (const [crafted, parts] of Object.entries(own.ItemRecipe || {})) {
      if (Array.isArray(parts) && parts.length === 2) recipes[[...parts].sort().join("+")] = crafted;
    }
    UI = { host, P, SD, ED, W, E, own, recipes,
      components: new Set(own.ItemComponents || []),
      known: { dex: P.dex, items: new Set(allItems), synergies: Object.keys(own.SynergyTiers || {}),
        abilities: new Set(Object.keys(P.abilities)), weathers: Object.keys(own.Weather || { NEUTRAL: 1 }) },
      itemGroups: itemGroups(own, allItems),
      roster: Object.keys(P.dex).filter(n => !P.dex[n].i.startsWith("0000"))
        .sort((a, b) => RARITY_ORDER.indexOf(P.dex[a].r) - RARITY_ORDER.indexOf(P.dex[b].r)
          || P.dex[a].f.localeCompare(P.dex[b].f) || P.dex[a].s - P.dex[b].s),
      wide: window.matchMedia("(min-width: 1181px)") };
    const draft = local.read(KEYS.draft, null);
    S.board = cleanBoard(draft?.board || blankBoard("My board"), UI.known);
    S.saved = draft?.saved ?? (Saves.get(S.board.id) ? boardKey(cleanBoard(Saves.get(S.board.id), UI.known)) : null);
    S.history = []; S.future = []; S.selected = null; S.armed = null; S.result = null; S.compare = null; S.mode = "edit";
    S.tab = UI.wide.matches ? "details" : "pokemon";
    build();
  } catch (err) {
    console.error(err);
    if (host.isConnected) host.innerHTML = `<div class="panel empty-note">The board couldn't be loaded (${esc(err.message)}). Reload the page to try again.</div>`;
  }
}

// The game's item lists, as the inventory groups them
function itemGroups(own, allItems) {
  const set = list => new Set(list || []);
  const components = set(own.ItemComponents), stones = set(own.SynergyItems), shiny = set([...(own.ShinyItems || []), ...(own.GoldenEggItems || [])]);
  const artificial = set(own.ArtificialItems);
  const crafted = (own.CraftableItems || []).filter(i => !stones.has(i));
  const used = new Set([...components, ...crafted, ...stones, ...shiny, ...artificial]);
  return [
    ["components", "Components", [...components]],
    ["crafted", "Crafted", crafted],
    ["stones", "Stones & memories", [...stones]],
    ["shiny", "Shiny & golden", [...shiny].filter(i => allItems.includes(i))],
    ["artificial", "Artificial", [...artificial]],
    ["other", "Other", allItems.filter(i => !used.has(i))],
  ].map(([key, label, items]) => ({ key, label, items: items.filter(i => allItems.includes(i)) }));
}

/* ---------- the layout ---------- */
function build() {
  const h = UI.host;
  h.innerHTML = `<div class="pb" data-mode="edit">
    <div class="pb-bar panel" id="pb-bar"></div>
    <div class="pb-main">
      <aside class="pb-left panel" id="pb-left"></aside>
      <section class="pb-center">
        <div class="panel pb-stagebox"><div id="pb-board"></div><div class="pb-battle" id="pb-battle" hidden></div></div>
        <div class="pb-synstrip" id="pb-synstrip"></div>
      </section>
      <aside class="pb-right panel" id="pb-right">
        <div class="pb-tabs" role="tablist" id="pb-tabs"></div>
        <div class="pb-tabbody" data-body="pokemon"></div>
        <div class="pb-tabbody" data-body="details"></div>
        <div class="pb-tabbody" data-body="items"></div>
        <div class="pb-tabbody" data-body="synergies"></div>
      </aside>
    </div>
    <section class="panel pb-bottom" id="pb-bottom"></section>
    <div class="pb-trash" id="pb-trash" data-drop="trash" hidden>${icon("trash")} Drop here to take it off the board</div>
  </div>`;
  UI.root = h.querySelector(".pb");
  UI.picker = document.createElement("div");
  UI.picker.className = "pb-picker";
  UI.picker.innerHTML = `<div class="panel-h">Pokémon<span class="sub">drag onto the board, or tap one then a cell</span></div>
    <div class="pk-tools"><input type="search" class="pb-input" placeholder="Search Pokémon…" aria-label="Search Pokémon" data-in="pk-q">
      <details class="pk-filters"><summary>Filters <span class="chip grey" id="pk-count"></span></summary><div id="pk-filter-body"></div></details></div>
    <div class="pk-list" id="pk-list"></div>`;
  placePicker();
  UI.wide.addEventListener?.("change", onWideChange);
  bindEvents(UI.root);
  renderFilters();
  renderPickerList();
  refresh();
}
function onWideChange() {
  if (!UI?.host.isConnected) return UI?.wide.removeEventListener?.("change", onWideChange);
  placePicker();
  if (UI.wide.matches && S.tab === "pokemon") S.tab = "details";
  renderRight();
}
// The Pokémon list sits in the left column on wide screens, and is the first tab of the side panel otherwise
function placePicker() {
  const target = UI.wide.matches ? UI.root.querySelector("#pb-left") : UI.root.querySelector('[data-body="pokemon"]');
  if (UI.picker.parentNode !== target) target.append(UI.picker);
}

function refresh() {
  renderBar();
  renderBoard();
  renderSynStrip();
  renderRight();
  renderBottom();
}

/* ---------- the top bar: name, history, saving, mode ---------- */
function renderBar() {
  const dirty = S.saved !== boardKey(S.board);
  const status = S.saved == null ? "Not saved yet" : dirty ? "Unsaved changes" : "Saved";
  const btn = (act, label, ic, extra = "") => `<button class="btn" data-act="${act}" ${extra}>${icon(ic)}<span>${label}</span></button>`;
  UI.root.querySelector("#pb-bar").innerHTML = `
    <input class="pb-name" value="${esc(S.board.name)}" maxlength="60" aria-label="Board name" data-in="name">
    <span class="pb-status ${dirty ? "dirty" : ""}" title="Your boards are kept in this browser">${status}</span>
    <span class="pb-group">
      <button class="btn icon" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo" ${S.history.length ? "" : "disabled"}>${icon("undo")}</button>
      <button class="btn icon" data-act="redo" title="Redo (Ctrl+Y)" aria-label="Redo" ${S.future.length ? "" : "disabled"}>${icon("redo")}</button>
      ${btn("revert", "Revert", "undo", `title="Back to the last saved version" ${S.saved != null && dirty ? "" : "disabled"}`)}
      ${btn("clear", "Clear", "trash", `title="Take every Pokémon off" ${S.board.units.length ? "" : "disabled"}`)}
      <button class="btn red" data-act="reset-all" title="Start this board over: no Pokémon, and the game's own synergy and sandbox settings" ${isFresh(S.board) ? "disabled" : ""}>${icon("reset")}<span>Reset board</span></button>
    </span>
    <span class="pb-group">
      <button class="btn primary" data-act="save" title="Save (Ctrl+S)" ${dirty || S.saved == null ? "" : "disabled"}>${icon("save")}<span>Save</span></button>
      ${btn("saves", "Boards", "folder", 'title="Your saved boards: open, copy, export, delete"')}
      ${btn("new", "New", "plus")}
      ${btn("duplicate", "Duplicate", "copy")}
      ${btn("export", "Export", "download", 'title="Download this board as a file"')}
      ${btn("import", "Import", "upload", 'title="Open a board file"')}
      <button class="btn icon" data-act="settings" title="Sandbox settings" aria-label="Sandbox settings">${icon("gear")}</button>
    </span>
    <span class="seg pb-mode" role="group" aria-label="Mode">
      <button data-act="mode-edit" class="${S.mode === "edit" ? "on" : ""}" aria-pressed="${S.mode === "edit"}">Editor</button>
      <button data-act="mode-fight" class="${S.mode === "fight" ? "on" : ""}" aria-pressed="${S.mode === "fight"}">Fight</button>
    </span>`;
}

/* ---------- the board ---------- */
function renderBoard() {
  const b = S.board, el = UI.root.querySelector("#pb-board");
  UI.root.dataset.mode = S.mode;
  UI.root.querySelector("#pb-battle").hidden = S.mode !== "fight";
  el.hidden = S.mode === "fight";
  if (S.mode === "fight") return;
  const armed = S.armed ? (S.armed.kind === "pokemon" ? `Placing ${pkName(S.armed.name)}: tap a cell` : `Giving ${itemName(S.armed.item)}: tap a Pokémon`) : "";
  let cells = "";
  for (let y = b.rows - 1; y >= 0; y--) {
    for (let x = 0; x < b.cols; x++) {
      const u = unitAt(x, y), side = sideOf(b, y);
      const focus = S.focus ? S.focus[0] === x && S.focus[1] === y : x === 0 && y === 0;
      const label = `${side === "blue" ? "Blue" : "Red"} side, column ${x + 1}, row ${y + 1}${u ? `: ${pkName(u.name)}` : ", empty"}`;
      cells += `<div class="pb-cell ${side} ${y === b.rows / 2 ? "mid" : ""} ${u ? "has" : ""} ${u && u.id === S.selected ? "sel" : ""}"
        data-cell="${x},${y}" data-drop="cell" role="gridcell" tabindex="${focus ? 0 : -1}" aria-label="${esc(label)}">${u ? unitHTML(u) : ""}</div>`;
    }
  }
  const blue = b.units.filter(u => u.team === "blue").length, red = b.units.length - blue;
  el.innerHTML = `<div class="pb-boardhead"><span class="chip red">Red side · ${red}</span>
      <span class="muted pb-hint">${armed ? `<b class="gold">${esc(armed)}</b> · <button class="linkish" data-act="disarm">stop</button>`
        : "Drag Pokémon around · right-click (or hold) one for more"}</span></div>
    <div class="pb-grid" style="--cols:${b.cols}" role="grid" aria-label="Board, ${b.cols} by ${b.rows}">${cells}</div>
    <div class="pb-boardhead"><span class="chip blue">Blue side · ${blue}</span>
      <span class="muted pb-hint">${b.cols}×${b.rows}${b.cols !== 8 || b.rows !== 6 ? " (the game's board is 8×6)" : ""}</span></div>`;
}
function unitHTML(u) {
  const d = UI.P.dex[u.name];
  const edited = Object.keys(u.stats || {}).length || u.ability || u.passive != null;
  return `<div class="pb-unit" data-drag="unit" data-unit="${esc(u.id)}" style="--rar:${RARITY[d.r] || "var(--dim)"}" title="${esc(pkName(u.name))}">
    ${portraitOf(u.name, 48)}
    ${d.s ? `<span class="pb-stars">${stars(d.s)}</span>` : ""}
    ${edited ? `<span class="pb-edited" title="Stats or ability changed">✎</span>` : ""}
    ${u.items.length ? `<span class="pb-items">${u.items.map(i => itemIcon(i, 15)).join("")}</span>` : ""}
  </div>`;
}

// Each side's active synergies under the board, at a glance
function renderSynStrip() {
  const row = team => {
    const active = synergyRows(team).filter(r => r.level > 0 || r.count > 0).sort((a, b) => b.level - a.level || b.count - a.count);
    return `<div class="pb-synrow"><span class="chip ${team}">${team === "blue" ? "Blue" : "Red"}</span>${active.length ? active.map(r =>
      `<span class="syn ${r.level ? "" : "t0"}" title="${esc(synName(r.syn))}: ${r.count}${r.level ? `, level ${r.level}` : ""}${r.off ? " (turned off)" : ""}">${spr("synergy", r.syn, 24)}<em>${r.count}</em></span>`).join("")
      : `<span class="muted">no synergies</span>`}${S.board.syn[team].mode === "manual" ? `<span class="chip gold">set by hand</span>` : ""}</div>`;
  };
  UI.root.querySelector("#pb-synstrip").innerHTML = row("red") + row("blue");
}

/* ---------- the Pokémon list ---------- */
function renderFilters() {
  const f = S.picker;
  const synergies = UI.known.synergies;
  const toggle = (group, value, label, on) => `<button class="pill ${on ? "on" : ""}" data-filter="${group}" data-value="${esc(value)}" aria-pressed="${on}">${label}</button>`;
  UI.picker.querySelector("#pk-filter-body").innerHTML = `
    <div class="pk-fgroup"><span class="eyebrow">Types (all of)</span><div class="pk-syns">${synergies.map(s =>
      `<button class="pk-syn ${f.syn.includes(s) ? "on" : ""}" data-filter="syn" data-value="${s}" title="${esc(synName(s))}" aria-pressed="${f.syn.includes(s)}">${spr("synergy", s, 22)}</button>`).join("")}</div></div>
    <div class="pk-fgroup"><span class="eyebrow">Rarity</span><div class="pills">${RARITY_ORDER.filter(r => UI.roster.some(n => UI.P.dex[n].r === r))
      .map(r => toggle("rarity", r, `<span style="color:${RARITY[r]}">${titleCase(r)}</span>`, f.rarity.includes(r))).join("")}</div></div>
    <div class="pk-fgroup"><span class="eyebrow">Stage</span><div class="pills">${[1, 2, 3, 4].map(s => toggle("stars", s, stars(s), f.stars.includes(s))).join("")}</div></div>
    <div class="pk-fgroup"><span class="eyebrow">Role</span><div class="pills">${[["", "Any"], ["melee", "Melee"], ["ranged", "Ranged"]].map(([v, l]) => toggle("role", v, l, f.role === v)).join("")}</div></div>
    <div class="pk-fgroup"><span class="eyebrow">Pool</span><div class="pills">${[["", "Any"], ["regular", "Shop"], ["additional", "Additional picks"], ["regional", "Regional"]].map(([v, l]) => toggle("pool", v, l, f.pool === v)).join("")}</div></div>
    <button class="btn" data-act="clear-filters">Clear filters</button>`;
}
function pickerMatches() {
  const f = S.picker, q = f.q.trim().toLowerCase(), dex = UI.P.dex;
  return UI.roster.filter(n => {
    const d = dex[n];
    if (q && !pkName(n).toLowerCase().includes(q) && !n.toLowerCase().includes(q)) return false;
    if (f.syn.length && !f.syn.every(s => d.t.includes(s))) return false;
    if (f.rarity.length && !f.rarity.includes(d.r)) return false;
    if (f.stars.length && !f.stars.includes(d.s)) return false;
    if (f.role === "melee" && d.st.range > 1) return false;
    if (f.role === "ranged" && d.st.range <= 1) return false;
    if (f.pool === "additional" && !d.add) return false;
    if (f.pool === "regional" && !d.reg) return false;
    if (f.pool === "regular" && (d.add || d.reg)) return false;
    return true;
  });
}
function renderPickerList() {
  const list = pickerMatches(), dex = UI.P.dex, f = S.picker;
  const active = f.syn.length + f.rarity.length + f.stars.length + (f.role ? 1 : 0) + (f.pool ? 1 : 0);
  UI.picker.querySelector("#pk-count").textContent = active ? `${active} on · ${list.length}` : `${list.length}`;
  UI.picker.querySelector("#pk-list").innerHTML = list.length ? list.map(n => {
    const d = dex[n], ability = UI.P.abilities[d.a]?.[0] || titleCase(d.a);
    const tip = `${pkName(n)} · ${titleCase(d.r)} ${stars(d.s)}\n${d.t.map(synName).join(", ")}\n${ability} · ${d.st.range > 1 ? `range ${d.st.range}` : "melee"}${d.add ? "\nAdditional pick" : ""}${d.reg ? "\nRegional" : ""}`;
    return `<button class="pk-tile ${S.armed?.name === n ? "armed" : ""}" data-pick="${n}" data-drag="pokemon" style="--rar:${RARITY[d.r] || "var(--dim)"}" title="${esc(tip)}">
      ${portraitOf(n, 40)}<span class="pk-nm">${esc(pkName(n))}</span><span class="pk-st">${stars(d.s)}</span></button>`;
  }).join("") : `<div class="empty-note">No Pokémon match.</div>`;
}

/* ---------- the side panel ---------- */
function renderRight() {
  const tabs = [["pokemon", "Pokémon"], ["details", "Details"], ["items", "Items"], ["synergies", "Synergies"]]
    .filter(([k]) => k !== "pokemon" || !UI.wide.matches);
  if (UI.wide.matches && S.tab === "pokemon") S.tab = "details";
  UI.root.querySelector("#pb-tabs").innerHTML = tabs.map(([k, l]) =>
    `<button role="tab" class="${S.tab === k ? "on" : ""}" aria-selected="${S.tab === k}" data-tab="${k}">${l}</button>`).join("");
  UI.root.querySelectorAll(".pb-tabbody").forEach(el => { el.hidden = el.dataset.body !== S.tab; });
  if (S.tab === "details") renderDetails();
  if (S.tab === "items") renderItems();
  if (S.tab === "synergies") renderSynergies();
}

function renderDetails() {
  const el = UI.root.querySelector('[data-body="details"]');
  const u = unitById(S.selected);
  if (!u) {
    el.innerHTML = `<div class="empty-note">Pick a Pokémon on the board to change its stage, items, ability and stats.</div>
      <div class="panel-b pb-help"><h4>How it works</h4><ul>
        <li><b>Place</b>: drag a Pokémon from the list onto a cell, or tap it and then tap cells. Copies are fine.</li>
        <li><b>Move</b>: drag it to another cell (onto another Pokémon to swap). The bottom half is the blue side, the top half red.</li>
        <li><b>Remove</b>: drag it off the board, or press Delete.</li>
        <li><b>Items</b>: drag one from the Items tab onto a Pokémon. Two components make the game's item.</li>
        <li><b>Fight</b>: press Run fight below. It's the game's own fight code, with a seed so a fight can be replayed.</li></ul></div>`;
    return;
  }
  const d = UI.P.dex[u.name], def = baseStats(d), line = UI.E.lines[d.f] || [u.name];
  const passive = u.passive ?? UI.E.passives[u.name] ?? "NONE", gamePassive = UI.E.passives[u.name] || "NONE";
  const ability = u.ability || d.a, abilityInfo = UI.P.abilities[ability];
  const limit = S.board.settings.itemLimit || Infinity;
  const slots = [...u.items.map((i, n) => `<div class="pb-slot"><span class="pb-slot-i">${itemIcon(i, 26)}</span><span class="pb-slot-n">${esc(itemName(i))}</span>
      <button class="btn icon" data-act="unequip" data-index="${n}" title="Take off ${esc(itemName(i))}" aria-label="Take off ${esc(itemName(i))}">${icon("x")}</button></div>`)];
  if (u.items.length < limit) slots.push(`<button class="pb-slot empty" data-act="item-menu">${icon("plus")} Add item</button>`);
  const abilities = Object.entries(UI.P.abilities).sort((a, b) => a[1][0].localeCompare(b[1][0]));
  el.innerHTML = `<div class="pb-detail">
    <div class="pb-dhead"><span class="portrait-frame" style="border-bottom:2px solid ${RARITY[d.r] || "var(--dim)"}">${portraitOf(u.name, 56)}</span>
      <div style="min-width:0"><h3>${esc(pkName(u.name))}</h3>
        <div class="chips"><span class="chip ${u.team}">${u.team === "blue" ? "Blue" : "Red"} side</span><span class="chip grey">cell ${u.x + 1}, ${u.y + 1}</span>
          <span class="chip" style="color:${RARITY[d.r]}">${titleCase(d.r)}</span></div>
        <div class="pb-types">${d.t.map(t => `<span title="${esc(synName(t))}">${spr("synergy", t, 20)}</span>`).join("")}<a href="#mon-${esc(u.name)}" class="muted" style="font-size:12px;margin-left:6px">Pokémon page</a></div></div></div>
    <div class="pb-dactions">
      <button class="btn" data-act="dup-unit">${icon("copy")}<span>Copy</span></button>
      <button class="btn" data-act="flip-unit" title="To the same cell on the other side">${icon("swap")}<span>Other side</span></button>
      <button class="btn danger" data-act="remove-unit">${icon("trash")}<span>Remove</span></button></div>
    ${line.length > 1 ? `<div class="pb-sec"><h4>Stage <span class="muted">(a Pokémon's level in this game is its evolution)</span></h4><div class="pb-line">${line.map(n =>
      `<button class="pb-evo ${n === u.name ? "on" : ""}" data-act="evolve" data-name="${n}" title="${esc(pkName(n))}">${portraitOf(n, 32)}<span class="stars">${stars(UI.P.dex[n].s)}</span></button>`).join("")}</div></div>` : ""}
    <div class="pb-sec"><h4>Items <span class="muted">${S.board.settings.itemLimit ? `${u.items.length}/3` : `${u.items.length}, no limit`}</span></h4><div class="pb-slots">${slots.join("")}</div></div>
    <div class="pb-sec"><h4>Ability ${u.ability ? `<span class="chip gold">changed</span> <button class="linkish" data-act="reset-ability">back to ${esc(UI.P.abilities[d.a]?.[0] || d.a)}</button>` : ""}</h4>
      <select class="pb-input" data-in="ability" aria-label="Ability">${abilities.map(([k, [n]]) => `<option value="${k}" ${k === ability ? "selected" : ""}>${esc(n)}${k === d.a ? " (its own)" : ""}</option>`).join("")}</select>
      ${abilityInfo ? `<p class="pb-desc">${abilityText(abilityInfo[1], d.s)}</p>` : ""}</div>
    <div class="pb-sec"><h4>Passive ${u.passive != null ? `<span class="chip gold">changed</span>` : ""}</h4>
      ${gamePassive === "NONE" ? `<p class="muted pb-desc">${esc(pkName(u.name))} has no passive.</p>` : `<label class="pb-check"><input type="checkbox" data-in="passive" ${passive !== "NONE" ? "checked" : ""}>
        <span><b>${esc(titleCase(gamePassive))}</b> on</span></label><p class="pb-desc">${describe(UI.W.passive_description?.[gamePassive] || "")}</p>`}</div>
    <div class="pb-sec"><h4>Stats ${Object.keys(u.stats).length ? `<button class="linkish" data-act="reset-stats">reset all</button>` : ""}</h4>
      <table class="pb-stats"><thead><tr><th class="l">Stat</th><th>Game</th><th>Here</th><th></th></tr></thead><tbody>
      ${STAT_KEYS.map(k => { const on = u.stats[k] != null; return `<tr class="${on ? "edited" : ""}"><td class="l">${STAT_LABELS[k]}</td><td class="muted num">${def[k]}</td>
        <td><input class="pb-num" type="number" inputmode="decimal" step="${k === "critPower" ? 0.1 : 1}" value="${on ? u.stats[k] : def[k]}" data-in="stat" data-stat="${k}" aria-label="${STAT_LABELS[k]}"></td>
        <td>${on ? `<button class="btn icon" data-act="reset-stat" data-stat="${k}" title="Back to ${def[k]}" aria-label="Reset ${STAT_LABELS[k]}">${icon("reset")}</button>` : ""}</td></tr>`; }).join("")}
      </tbody></table>
      <p class="muted pb-note">Changed stats replace the Pokémon's own before items and synergies add theirs. Crit, shield are added on top at the start of the fight. The game has no such setting: it's for trying things out.</p></div>
  </div>`;
}

function renderItems() {
  const el = UI.root.querySelector('[data-body="items"]');
  const f = S.itemFilter, q = f.q.trim().toLowerCase();
  const groups = UI.itemGroups.filter(g => f.group === "all" || g.key === f.group)
    .map(g => ({ ...g, items: g.items.filter(i => !q || itemName(i).toLowerCase().includes(q) || i.toLowerCase().includes(q)) }))
    .filter(g => g.items.length);
  const recipeOf = {};
  for (const [parts, crafted] of Object.entries(UI.recipes)) recipeOf[crafted] = parts.split("+");
  el.innerHTML = `<div class="pk-tools"><input type="search" class="pb-input" placeholder="Search items…" aria-label="Search items" data-in="item-q" value="${esc(f.q)}">
    <div class="pills">${[["all", "All"], ...UI.itemGroups.map(g => [g.key, g.label])].map(([k, l]) =>
      `<button class="pill ${f.group === k ? "on" : ""}" data-igroup="${k}">${esc(l)}</button>`).join("")}</div></div>
    <div class="pb-ilist">${groups.length ? groups.map(g => `<div class="pb-igroup"><h4>${esc(g.label)} <span class="muted">${g.items.length}</span></h4><div class="pb-igrid">${g.items.map(i => {
      const tip = `${itemName(i)}\n${String(UI.W.item_description?.[i] || "").replace(/\{\{[^}]*\}\}/g, "")}${recipeOf[i] ? `\nMade from ${recipeOf[i].map(itemName).join(" + ")}` : ""}`;
      return `<button class="pb-item ${S.armed?.item === i ? "armed" : ""}" data-gear="${i}" data-drag="item" title="${esc(tip)}" aria-label="${esc(itemName(i))}">${itemIcon(i, 30)}</button>`;
    }).join("")}</div></div>`).join("") : `<div class="empty-note">No items match.</div>`}
    <p class="muted pb-note">Every item as many times as you like. Drag one onto a Pokémon, or tap it then tap Pokémon. ${S.board.settings.combine ? "A component given to a Pokémon holding another one makes the game's item from the two." : "Components don't combine (sandbox setting)."} Some items only do something in a real game (gold, the shop, the player): here they do nothing.</p></div>`;
}

function synergyRows(team) {
  const b = S.board, cfg = b.syn[team], own = UI.own;
  const units = b.units.filter(u => u.team === team);
  let counts = new Map();
  try { counts = own.computeSynergies(units.map(u => UI.E.boardPokemon(u))); } catch (err) { console.warn("Synergies couldn't be counted:", err); }
  return UI.known.synergies.map(syn => {
    const count = counts.get?.(syn) || 0;
    const game = own.SynergyTiersThresholds?.[syn] || D.thresholds[syn] || [];
    const thresholds = cfg.thresholds[syn] || game;
    const auto = thresholds.filter(t => count >= t).length;
    const off = cfg.off.includes(syn);
    const tiers = own.SynergyTiers[syn] || [];
    const chosen = cfg.mode === "manual" ? clamp(cfg.levels[syn] ?? auto, 0, tiers.length) : Math.min(auto, tiers.length);
    const level = off ? 0 : chosen;
    return { syn, count, game, thresholds, auto, off, level, chosen, tiers, effect: level ? tiers[level - 1] : null, custom: Boolean(cfg.thresholds[syn]) };
  });
}
// What a side's synergies send into the fight: the effect of each one's level, and counts that give the game those
// same levels (it reads counts too, for "has this synergy active")
function teamInput(team) {
  const levels = {}, counts = {};
  for (const r of synergyRows(team)) {
    if (r.level > 0) levels[r.syn] = r.level;
    const first = r.game[0] ?? Infinity;
    counts[r.syn] = r.level > 0 ? Math.max(r.count, r.game[r.level - 1] ?? r.count) : Math.min(r.count, first - 1);
  }
  return { levels, counts };
}

function renderSynergies() {
  const el = UI.root.querySelector('[data-body="synergies"]');
  const team = S.synTeam, cfg = S.board.syn[team], manual = cfg.mode === "manual";
  const rows = synergyRows(team);
  const shown = S.showAllSyn ? rows : rows.filter(r => r.count > 0 || r.level > 0 || r.custom || r.off || (manual && cfg.levels[r.syn] != null));
  shown.sort((a, b) => b.level - a.level || b.count - a.count || a.syn.localeCompare(b.syn));
  el.innerHTML = `<div class="pk-tools">
      <span class="seg" role="group" aria-label="Side"><button class="${team === "blue" ? "on" : ""}" data-act="syn-team" data-team="blue">Blue side</button><button class="${team === "red" ? "on" : ""}" data-act="syn-team" data-team="red">Red side</button></span>
      <span class="seg" role="group" aria-label="Levels"><button class="${manual ? "" : "on"}" data-act="syn-mode" data-mode="auto" title="Counted from the board, as the game does">From the board</button><button class="${manual ? "on" : ""}" data-act="syn-mode" data-mode="manual" title="Choose each synergy's level yourself">Set by hand</button></span></div>
    <div class="pb-synlist">${shown.length ? shown.map(r => {
      const pips = r.thresholds.map((t, i) => `<span class="pip ${r.count >= t ? "on" : ""} ${r.level === i + 1 ? "lvl" : ""}" title="Level ${i + 1} at ${t}">${t}</span>`).join("");
      const control = manual ? `<select class="pb-input pb-lvl" data-in="syn-level" data-syn="${r.syn}" aria-label="${esc(synName(r.syn))} level">${Array.from({ length: r.tiers.length + 1 }, (_, i) =>
        `<option value="${i}" ${r.chosen === i ? "selected" : ""}>${i ? `Level ${i}` : "Off"}</option>`).join("")}</select>` : `<b class="num">${r.level ? `Lv ${r.level}` : "–"}</b>`;
      return `<div class="pb-synr ${r.off ? "off" : ""}">
        <div class="pb-synhead">${spr("synergy", r.syn, 26)}<b>${esc(synName(r.syn))}</b><span class="num muted" title="Pokémon counted (each evolution line once, as the game counts)">${r.count}</span>
          <span class="pips">${pips}</span>${control}
          <label class="pb-switch" title="${r.off ? "Turned off" : "On"}"><input type="checkbox" data-in="syn-on" data-syn="${r.syn}" ${r.off ? "" : "checked"} aria-label="${esc(synName(r.syn))} on"><i></i></label></div>
        ${r.effect ? `<p class="pb-desc"><b>${esc(effectName(r.effect))}</b>: ${describe(UI.W.effect_description?.[r.effect] || "")}</p>` : ""}
        <div class="pb-thr"><label>Thresholds <input class="pb-input" data-in="syn-thr" data-syn="${r.syn}" value="${r.thresholds.join(", ")}" aria-label="${esc(synName(r.syn))} thresholds"></label>
          ${r.custom ? `<button class="linkish" data-act="syn-thr-reset" data-syn="${r.syn}">game's: ${r.game.join(", ")}</button>` : ""}</div>
      </div>`;
    }).join("") : `<div class="empty-note">No synergies on this side yet.</div>`}</div>
    <div class="panel-b"><label class="pb-check"><input type="checkbox" data-in="syn-all" ${S.showAllSyn ? "checked" : ""}><span>Show every synergy</span></label>
    <p class="muted pb-note">Counted like the game: each evolution line once, items that add a type, Dragon's second types. The level picks which of the game's effects the side gets. Changed thresholds and hand-set levels are sandbox settings: the game's own are shown next to them.</p></div>`;
}

/* ---------- the bottom panel: running the fight, the log, the numbers ---------- */
function renderBottom() {
  const el = UI.root.querySelector("#pb-bottom");
  const R = S.result?.R, stale = S.result && S.result.key !== fightKey();
  const pb = Playback;
  const seed = S.board.settings.seed;
  const controls = `<div class="pb-controls">
    <button class="btn primary" data-act="run">${icon("play")}<span>${R ? "Run again" : "Run fight"}</span></button>
    ${R && S.mode === "fight" ? `
      <button class="btn icon" data-act="toggle-play" title="${pb.playing ? "Pause" : "Play"} (Space)" aria-label="${pb.playing ? "Pause" : "Play"}">${icon(pb.playing ? "pause" : "play")}</button>
      <button class="btn icon" data-act="restart" title="From the start" aria-label="From the start">${icon("restart")}</button>
      <button class="btn icon" data-act="step" title="A tenth of a second on" aria-label="Step">${icon("step")}</button>
      <span class="seg" role="group" aria-label="Speed">${SPEEDS.map(s => `<button class="${pb.speed === s ? "on" : ""}" data-act="speed" data-speed="${s}">${s}×</button>`).join("")}</span>
      <input type="range" class="pb-scrub" min="0" max="${Math.round(R.duration)}" step="${Math.round(TICK)}" value="${Math.round(pb.t)}" aria-label="Fight time" data-in="scrub">
      <span class="num pb-time" id="pb-time">${fmtTime(pb.t)} / ${fmtTime(R.duration)}</span>` : R ? `<button class="btn" data-act="mode-fight">${icon("play")}<span>Watch it</span></button>` : ""}
    <label class="pb-seed" title="The same seed gives the same fight">Seed <input class="pb-input num" type="number" min="1" value="${seed}" data-in="seed" aria-label="Seed"></label>
    <button class="btn icon" data-act="new-seed" title="Another seed" aria-label="Another seed">${icon("dice")}</button>
  </div>`;
  let summary = "";
  if (R) {
    const alive = team => R.stats.filter(s => s.team === team && s.survived && s.unit).length;
    const word = R.winner === "draw" ? "Draw: both sides still standing at 45 s" : `${R.winner === "blue" ? "Blue" : "Red"} side wins`;
    summary = `<div class="pb-result ${R.winner}"><b>${word}</b><span class="muted">${fmtTime(R.duration)} · ${alive("blue")} blue and ${alive("red")} red left standing · seed ${S.result.seed}</span>
      ${stale ? `<span class="chip gold">The board changed since: run it again</span>` : ""}
      ${R.notes.length ? `<span class="chip red" title="${esc(R.notes.join("\n"))}">${R.notes.length} part${R.notes.length === 1 ? "" : "s"} of the game's code didn't run</span>` : ""}</div>`;
  }
  const tabs = [["log", "Battle log"], ["damage", "Damage"], ["compare", "Compare"], ["accuracy", "What's exact"]];
  el.innerHTML = controls + summary + `<div class="tabs pb-btabs">${tabs.map(([k, l]) => `<a href="#board" class="${S.bottom === k ? "on" : ""}" data-btab="${k}">${l}</a>`).join("")}</div>
    <div class="pb-bbody" id="pb-bbody">${bottomBody()}</div>`;
}
function bottomBody() {
  const R = S.result?.R;
  if (S.bottom === "accuracy") return accuracyNotes();
  if (S.bottom === "compare") return compareView();
  if (!R) return `<div class="empty-note">Run the fight to see what happened.</div>`;
  if (S.bottom === "damage") return damageTable(R);
  return logView(R);
}
// Who's who in a fight: names and sides by the fight's ids (summons included)
function fightCast(R) {
  if (R.cast) return R.cast;
  const cast = {};
  for (const f of [R.frames[0], R.frames.at(-1)]) for (const u of f?.units || []) cast[u.id] ||= { name: u.name, team: u.team, index: u.index, unit: u.unit };
  for (const f of R.frames) for (const u of f.units) cast[u.id] ||= { name: u.name, team: u.team, index: u.index, unit: u.unit };
  R.cast = cast;
  return cast;
}
function logView(R) {
  const cast = fightCast(R), filter = S.logFilter;
  const who = id => { const c = cast[id]; return c ? `<span class="lg-who ${c.team}">${esc(pkName(c.name))}${c.unit ? "" : " <i>(summoned)</i>"}</span>` : `<span class="muted">the board</span>`; };
  const lines = [];
  for (const e of R.log) {
    const by = cast[e.kind === "cast" ? e.by : e.from], to = cast[e.to];
    const team = (by || to)?.team;
    if ((filter === "blue" || filter === "red") && team !== filter) continue;
    if (e.kind === "cast") {
      lines.push([e.t, `${who(e.by)} cast <b>${esc(UI.P.abilities[e.skill]?.[0] || titleCase(String(e.skill)))}</b>`, "cast"]);
    } else if (e.kind === "damage") {
      if (e.death) lines.push([e.t, `${who(e.to)} was knocked out${e.from ? ` by ${who(e.from)}` : ""}`, "ko"]);
      if (filter !== "key") lines.push([e.t, `${who(e.from)} hit ${who(e.to)} for <b class="dmg-${String(e.type).toLowerCase()}">${e.amount}</b> ${String(e.type).toLowerCase()}`, "hit"]);
    } else if (e.kind === "heal" && filter !== "key") {
      lines.push([e.t, `${who(e.to)} healed <b class="good">${e.amount}</b>${e.from && e.from !== e.to ? ` by ${who(e.from)}` : ""}`, "heal"]);
    }
  }
  lines.push([R.duration, R.winner === "draw" ? "Time's up: a draw" : `${R.winner === "blue" ? "Blue" : "Red"} side wins`, "end"]);
  const shown = lines.slice(0, S.logLimit);
  return `<div class="pb-logtools"><div class="pills">${[["key", "Casts and knockouts"], ["all", "Everything"], ["blue", "Blue side"], ["red", "Red side"]].map(([k, l]) =>
    `<button class="pill ${filter === k ? "on" : ""}" data-logf="${k}">${l}</button>`).join("")}</div><span class="muted">${lines.length} lines · click one to jump there</span></div>
    <div class="pb-log" id="pb-log">${shown.map(([t, html, kind]) => `<button class="lg ${kind}" data-seek="${Math.round(t)}"><span class="num muted">${(t / 1000).toFixed(1)}</span><span>${html}</span></button>`).join("")}
    ${lines.length > shown.length ? `<button class="more" data-act="log-more">Show ${Math.min(300, lines.length - shown.length)} more</button>` : ""}</div>`;
}
function damageTable(R) {
  const rows = R.stats.filter(s => s.unit || s.dealt || s.taken).sort((a, b) => b.dealt - a.dealt);
  const top = Math.max(1, ...rows.map(s => s.dealt));
  const total = team => R.stats.filter(s => s.team === team).reduce((a, s) => a + s.dealt, 0);
  return `<div class="table-wrap"><table class="grid compact pb-dmg"><thead><tr><th class="l">Pokémon</th><th class="l">Damage dealt</th><th>Taken</th><th>Blocked</th><th>Healed</th><th>Shields</th><th>Casts</th><th>Attacks</th><th></th></tr></thead><tbody>
    ${rows.map(s => `<tr class="${s.team}"><td class="l"><span class="who-cell">${portraitOf(s.name, 24)}<b class="lg-who ${s.team}">${esc(pkName(s.name))}</b>${s.unit ? "" : `<span class="muted">summoned</span>`}</span></td>
      <td class="l"><span class="dmgbar" title="${s.physical} physical, ${s.special} special, ${s.trueDamage} true"><i class="ph" style="width:${s.physical / top * 100}%"></i><i class="sp" style="width:${s.special / top * 100}%"></i><i class="tr" style="width:${s.trueDamage / top * 100}%"></i></span><b class="num">${fmt(s.dealt)}</b></td>
      <td>${fmt(s.taken)}</td><td class="muted">${fmt(s.blocked)}</td><td>${fmt(s.healed)}</td><td>${fmt(s.shielded)}</td><td>${s.casts}</td><td>${s.attacks}</td>
      <td>${s.survived ? `<span class="chip blue">standing</span>` : `<span class="chip grey">KO</span>`}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted pb-note">Blue dealt ${fmt(total("blue"))}, red ${fmt(total("red"))}. Damage, heals, shields and blocked damage are the game's own damage meter; taken is every hit counted as it landed. Bars: <span class="dmg-physical">physical</span>, <span class="dmg-special">special</span>, <span class="dmg-true">true</span>.</p>`;
}
function compareView() {
  const c = S.compare;
  const saves = Saves.list().filter(b => b.id !== S.board.id);
  const table = c?.rows?.length ? `<div class="table-wrap"><table class="grid compact"><thead><tr><th class="l">Board</th><th>Fights</th><th>Blue wins</th><th>Red wins</th><th>Draws</th><th>Avg time</th><th>Blue left</th><th>Red left</th></tr></thead><tbody>
    ${c.rows.map(r => `<tr><td class="l"><b>${esc(r.name)}</b></td><td>${r.n}</td><td class="blue">${pct(r.blue, r.n)}%</td><td class="bad">${pct(r.red, r.n)}%</td><td class="muted">${pct(r.draw, r.n)}%</td>
      <td>${fmtTime(r.time / r.n)}</td><td>${(r.blueLeft / r.n).toFixed(1)}</td><td>${(r.redLeft / r.n).toFixed(1)}</td></tr>`).join("")}</tbody></table></div>` : "";
  return `<div class="pb-compare"><p class="muted" style="margin:0">Fights have luck in them (crits, dodges, some abilities). Run each board many times with different seeds to see how often each side wins.</p>
    <div class="pb-ctools"><label>Fights per board <input class="pb-input num" type="number" min="1" max="200" value="${c?.n || 20}" data-in="compare-n"></label>
      ${saves.length ? `<details><summary>Also compare saved boards (${saves.length})</summary><div class="pb-cboards">${saves.map(b =>
        `<label class="pb-check"><input type="checkbox" data-in="compare-board" value="${esc(b.id)}" ${c?.boards?.includes(b.id) ? "checked" : ""}><span>${esc(b.name)} <span class="muted">${(b.units || []).length} Pokémon</span></span></label>`).join("")}</div></details>` : ""}
      <button class="btn primary" data-act="compare" ${c?.running ? "disabled" : ""}>${c?.running ? `Running… ${c.done}/${c.total}` : "Run"}</button></div>
    ${table}</div>`;
}
function accuracyNotes() {
  return `<div class="pb-acc">
    <div><h4 class="good">The game's own code</h4><ul>
      <li>The whole fight: the game's Simulation, each Pokémon's states (moving with the game's pathfinding, attacking, casting), targets, attack speed, dodge, crits and the damage formula.</li>
      <li>Every ability's own code (the game's 570 ability classes), statuses (burn, poison, sleep, freeze, charm…), passives, item effects, synergy effects and weather.</li>
      <li>Synergy counts (each evolution line once, items that add types, Dragon's second types) and each level's effect.</li>
      <li>The animations are the game's own, from its site.</li></ul></div>
    <div><h4 class="gold">Close to the game, not the same</h4><ul>
      <li>Only the fight: there's no player behind each side (gold, level, shop, bench, titles, chef's dishes, flower pots unlocked). Effects that read those see an empty player.</li>
      <li>Things that happen to a Pokémon in a game before the fight (form changes, stacks it built up) don't happen.</li>
      <li>Summoned Pokémon are made from the Pokédex's numbers.</li>
      <li>Randomness comes from the seed, so a fight can be replayed; the game rolls its own.</li>
      <li>The replay is drawn from where everyone was each 1/30 s; projectiles and some timings on screen are approximate. The numbers are not.</li></ul></div>
    <div><h4 class="bad">Not the game at all (sandbox)</h4><ul>
      <li>Changed stats, abilities and passives, more than 3 items, hand-set synergy levels, changed thresholds, and boards other than 8×6.</li>
      <li>Anything marked "changed" on a Pokémon or a synergy.</li></ul></div></div>`;
}

/* ---------- changes, history, saving ---------- */
function change(fn, { keepSelection = false } = {}) {
  const before = JSON.stringify(S.board);
  fn(S.board);
  tidy(S.board);
  if (JSON.stringify(S.board) === before) return false;
  S.history.push(before);
  if (S.history.length > 100) S.history.shift();
  S.future = [];
  S.board.updated = Date.now();
  if (!keepSelection && S.selected && !unitById(S.selected)) S.selected = null;
  afterChange();
  return true;
}
function afterChange() {
  local.write(KEYS.draft, { board: S.board, saved: S.saved });
  refresh();
}
function undo() {
  if (!S.history.length) return;
  S.future.push(JSON.stringify(S.board));
  S.board = JSON.parse(S.history.pop());
  if (S.selected && !unitById(S.selected)) S.selected = null;
  afterChange();
}
function redo() {
  if (!S.future.length) return;
  S.history.push(JSON.stringify(S.board));
  S.board = JSON.parse(S.future.pop());
  afterChange();
}
function save() {
  if (!Saves.put(S.board)) return toast("This browser won't keep it (storage is off or full). Export it to a file instead.");
  S.saved = boardKey(S.board);
  afterChange();
  toast(`Saved "${S.board.name}"`);
}
// Opens a board in the editor (asking first if the current one has unsaved changes)
async function openBoard(board, { saved }) {
  if (S.saved !== boardKey(S.board) && S.board.units.length && !(await confirmBox("Leave this board?",
    `"${esc(S.board.name)}" has changes that aren't saved. They'll be lost.`, "Leave it"))) return false;
  S.board = board;
  S.saved = saved ? boardKey(board) : null;
  S.history = []; S.future = []; S.selected = null; S.result = null; S.compare = null;
  setMode("edit");
  afterChange();
  return true;
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const fileName = b => `${(b.name || "board").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "board"}.pacboard.json`;
function exportBoard(b) {
  download(fileName(b), JSON.stringify({ format: BOARD_FORMAT, version: 1, exported: new Date().toISOString(), board: { ...b, format: undefined } }, null, 1));
}
function importBoard() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2e6) throw new Error("it's too big to be a board");
      const data = JSON.parse(await file.text());
      const raw = data?.format === BOARD_FORMAT && data.board ? data.board : data;
      if (!raw || !Array.isArray(raw.units)) throw new Error("it isn't a board file from this site");
      const board = cleanBoard(raw, UI.known);
      const dropped = raw.units.length - board.units.length;
      if (Saves.get(board.id)) board.id = uid();
      if (await openBoard(board, { saved: false })) toast(`Opened "${board.name}"${dropped > 0 ? ` (${dropped} Pokémon the game doesn't have were left out)` : ""}. Save it to keep it.`);
    } catch (err) {
      messageBox("That file couldn't be opened", esc(err.message));
    }
  };
  input.click();
}

/* ---------- placing, moving, items ---------- */
function place(name, x, y) {
  change(b => {
    const there = b.units.find(u => u.x === x && u.y === y);
    if (there) b.units = b.units.filter(u => u !== there);
    const unit = { id: uid(), name, x, y, team: sideOf(b, y), items: [], stats: {} };
    b.units.push(unit);
    S.selected = unit.id;
  });
}
function moveUnit(id, x, y) {
  change(b => {
    const u = b.units.find(v => v.id === id);
    if (!u) return;
    const there = b.units.find(v => v.x === x && v.y === y && v !== u);
    if (there) { there.x = u.x; there.y = u.y; }  // swap
    u.x = x; u.y = y;
  }, { keepSelection: true });
}
function removeUnit(id) {
  const u = unitById(id);
  if (!u) return;
  change(b => { b.units = b.units.filter(v => v.id !== id); });
  toast(`Took ${pkName(u.name)} off the board`, { undo: true });
}
function freeCell(team, near) {
  const b = S.board, half = b.rows / 2, rows = team === "blue" ? [...Array(half).keys()] : [...Array(half).keys()].map(r => r + half);
  const cells = rows.flatMap(y => [...Array(b.cols).keys()].map(x => [x, y])).filter(([x, y]) => !unitAt(x, y));
  if (!cells.length) return null;
  if (near) cells.sort((p, q) => Math.hypot(p[0] - near[0], p[1] - near[1]) - Math.hypot(q[0] - near[0], q[1] - near[1]));
  return cells[0];
}
function duplicateUnit(id) {
  const u = unitById(id);
  const cell = u && freeCell(u.team, [u.x, u.y]);
  if (!cell) return toast("No free cell on that side");
  change(b => {
    const copy = { ...JSON.parse(JSON.stringify(u)), id: uid(), x: cell[0], y: cell[1] };
    b.units.push(copy);
    S.selected = copy.id;
  });
}
// Everything on the board as a new board has it (its name aside)
const freshParts = b => ({ cols: b.cols, rows: b.rows, units: b.units, settings: b.settings, syn: b.syn });
const isFresh = b => JSON.stringify(freshParts(b)) === JSON.stringify(freshParts(blankBoard()));
// The board started over: no Pokémon, the game's own synergy settings for both sides, the default board size,
// stage, weather, item rules and seed; the last fight and comparisons go too. Undo brings it all back.
async function resetBoard() {
  const n = S.board.units.length;
  const mons = n ? `All ${n} Pokémon come off with their items and changes. ` : "";
  const text = `${mons}Both sides' synergy settings and the sandbox settings (size, stage, weather, items, seed) go back to the start. Undo brings it all back.`;
  if (!(await confirmBox("Reset the whole board?", text, "Reset board", { danger: true }))) return;
  S.result = null;
  S.compare = null;
  S.selected = null;
  S.armed = null;
  Playback.close();
  S.mode = "edit";
  change(b => Object.assign(b, freshParts(blankBoard())));
  renderPickerList();
  toast("The board was reset", { undo: true });
}
function flipUnit(id) {
  const u = unitById(id);
  if (!u) return;
  moveUnit(id, u.x, S.board.rows - 1 - u.y);
}
// An item onto a Pokémon, the way the game does it: two components make the item of their recipe; a Pokémon
// holds each item once, and three at most (unless the sandbox says otherwise)
function giveItem(id, item) {
  const u = unitById(id);
  if (!u) return;
  const limit = S.board.settings.itemLimit || Infinity;
  if (S.board.settings.combine && UI.components.has(item)) {
    const partner = u.items.find(i => UI.components.has(i) && UI.recipes[[i, item].sort().join("+")]);
    if (partner) {
      const crafted = UI.recipes[[partner, item].sort().join("+")];
      if (u.items.includes(crafted)) return toast(`${pkName(u.name)} already holds ${itemName(crafted)}`);
      change(b => { const v = b.units.find(w => w.id === id); v.items[v.items.indexOf(partner)] = crafted; }, { keepSelection: true });
      return toast(`${itemName(partner)} + ${itemName(item)} made ${itemName(crafted)}`);
    }
  }
  if (u.items.includes(item)) return toast(`${pkName(u.name)} already holds ${itemName(item)} (a Pokémon holds each item once)`);
  if (u.items.length >= limit) return toast(`${pkName(u.name)} already holds 3 items. Take one off first, or allow more in the sandbox settings.`);
  change(b => { b.units.find(w => w.id === id).items.push(item); }, { keepSelection: true });
}

/* ---------- events ---------- */
function bindEvents(root) {
  root.addEventListener("click", onClick);
  root.addEventListener("dblclick", onDoubleClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChangeInput);
  root.addEventListener("contextmenu", onContextMenu);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("keydown", onBoardKey);
  if (!bindEvents.global) {
    bindEvents.global = true;
    document.addEventListener("keydown", onGlobalKey);
  }
}

function onClick(e) {
  if (Drag.suppressClick) { Drag.suppressClick = false; e.preventDefault(); return; }
  const t = e.target;
  const act = t.closest("[data-act]");
  if (act && !act.disabled) return doAction(act.dataset.act, act, e);
  const tab = t.closest("[data-tab]");
  if (tab) { S.tab = tab.dataset.tab; return renderRight(); }
  const btab = t.closest("[data-btab]");
  if (btab) { e.preventDefault(); S.bottom = btab.dataset.btab; return renderBottom(); }
  const filter = t.closest("[data-filter]");
  if (filter) return toggleFilter(filter.dataset.filter, filter.dataset.value);
  const group = t.closest("[data-igroup]");
  if (group) { S.itemFilter.group = group.dataset.igroup; return renderItems(); }
  const logf = t.closest("[data-logf]");
  if (logf) { S.logFilter = logf.dataset.logf; S.logLimit = 300; return renderBottom(); }
  const seek = t.closest("[data-seek]");
  if (seek) { if (S.mode !== "fight") setMode("fight"); return Playback.seek(Number(seek.dataset.seek), true); }
  const pick = t.closest("[data-pick]");
  if (pick) { S.armed = S.armed?.name === pick.dataset.pick ? null : { kind: "pokemon", name: pick.dataset.pick }; renderPickerList(); return renderBoard(); }
  const gear = t.closest("[data-gear]");
  if (gear) {
    // with a Pokémon picked, a tap gives it the item; otherwise it's held, ready to tap onto Pokémon
    S.armed = S.armed?.item === gear.dataset.gear ? null : { kind: "item", item: gear.dataset.gear };
    renderItems();
    return renderBoard();
  }
  const cell = t.closest("[data-cell]");
  if (cell) return clickCell(...cell.dataset.cell.split(",").map(Number));
}
function clickCell(x, y) {
  S.focus = [x, y];
  const u = unitAt(x, y);
  if (S.armed?.kind === "pokemon") return place(S.armed.name, x, y);
  if (S.armed?.kind === "item") {
    if (u) giveItem(u.id, S.armed.item); else toast("Tap a Pokémon to give it the item");
    return;
  }
  S.selected = u ? u.id : null;
  if (u && S.tab !== "details") S.tab = "details";
  renderBoard();
  renderRight();
  focusCell(x, y);
}
function onDoubleClick(e) {
  const pick = e.target.closest("[data-pick]");
  if (!pick) return;
  // a double click puts it on the first free cell of the blue side
  const cell = freeCell("blue", [Math.floor(S.board.cols / 2), 0]);
  if (!cell) return toast("The blue side is full");
  S.armed = null;
  place(pick.dataset.pick, ...cell);
  renderPickerList();
}

async function doAction(act, el) {
  const u = unitById(S.selected);
  switch (act) {
    case "undo": return undo();
    case "redo": return redo();
    case "save": return save();
    case "revert": {
      const saved = Saves.get(S.board.id);
      if (!saved || !(await confirmBox("Back to the saved version?", "Every change since you last saved goes.", "Revert"))) return;
      change(b => Object.assign(b, cleanBoard(saved, UI.known)));
      return;
    }
    case "reset-all": return resetBoard();
    case "clear":
      if (await confirmBox("Clear the board?", `All ${S.board.units.length} Pokémon come off (Undo brings them back).`, "Clear")) change(b => { b.units = []; });
      return;
    case "new": return openBoard(blankBoard(), { saved: false });
    case "duplicate": {
      const copy = { ...JSON.parse(JSON.stringify(S.board)), id: uid(), name: `${S.board.name} (copy)`.slice(0, 60), created: Date.now(), updated: Date.now() };
      Saves.put(copy);
      if (await openBoard(copy, { saved: true })) toast(`Made a copy: "${copy.name}"`);
      return;
    }
    case "export": return exportBoard(S.board);
    case "import": return importBoard();
    case "saves": return savesDialog();
    case "settings": return settingsDialog();
    case "mode-edit": return setMode("edit");
    case "mode-fight": return setMode("fight");
    case "disarm": S.armed = null; renderPickerList(); renderBoard(); return renderRight();
    case "clear-filters": S.picker = { q: S.picker.q, syn: [], rarity: [], stars: [], role: "", pool: "" }; renderFilters(); return renderPickerList();
    case "dup-unit": return u && duplicateUnit(u.id);
    case "flip-unit": return u && flipUnit(u.id);
    case "remove-unit": return u && removeUnit(u.id);
    case "evolve": return u && change(b => { b.units.find(v => v.id === u.id).name = el.dataset.name; }, { keepSelection: true });
    case "unequip": return u && change(b => { b.units.find(v => v.id === u.id).items.splice(Number(el.dataset.index), 1); }, { keepSelection: true });
    case "item-menu": return u && itemMenu(el, u.id);
    case "reset-ability": return u && change(b => { delete b.units.find(v => v.id === u.id).ability; }, { keepSelection: true });
    case "reset-stats": return u && change(b => { b.units.find(v => v.id === u.id).stats = {}; }, { keepSelection: true });
    case "reset-stat": return u && change(b => { delete b.units.find(v => v.id === u.id).stats[el.dataset.stat]; }, { keepSelection: true });
    case "syn-team": S.synTeam = el.dataset.team; return renderSynergies();
    case "syn-mode": return change(b => { b.syn[S.synTeam].mode = el.dataset.mode; });
    case "syn-thr-reset": return change(b => { delete b.syn[S.synTeam].thresholds[el.dataset.syn]; });
    case "run": return runAndShow();
    case "toggle-play": return Playback.toggle();
    case "restart": return Playback.seek(0, true);
    case "step": return Playback.step();
    case "speed": return Playback.setSpeed(Number(el.dataset.speed));
    case "new-seed": return change(b => { b.settings.seed = 1 + Math.floor(Math.random() * 99999); });
    case "log-more": S.logLimit += 300; return renderBottom();
    case "compare": return runCompare();
  }
}

function toggleFilter(group, value) {
  const f = S.picker;
  if (group === "role" || group === "pool") f[group] = value;
  else {
    const v = group === "stars" ? Number(value) : value;
    f[group] = f[group].includes(v) ? f[group].filter(x => x !== v) : [...f[group], v];
  }
  renderFilters();
  renderPickerList();
}

function onInput(e) {
  const t = e.target, k = t.dataset.in;
  if (k === "pk-q") { S.picker.q = t.value; return renderPickerList(); }
  if (k === "item-q") {
    S.itemFilter.q = t.value;
    const pos = t.selectionStart;
    renderItems();
    const again = UI.root.querySelector('[data-in="item-q"]');
    again.focus();
    again.setSelectionRange(pos, pos);
    return;
  }
  if (k === "scrub") return Playback.seek(Number(t.value), false);
}
function onChangeInput(e) {
  const t = e.target, k = t.dataset.in, u = unitById(S.selected);
  if (k === "name") return change(b => { b.name = t.value.trim().slice(0, 60) || "Board"; });
  if (k === "seed") return change(b => { b.settings.seed = Math.max(1, Math.round(Number(t.value) || 1)); });
  if (k === "ability" && u) return change(b => { const v = b.units.find(w => w.id === u.id); if (t.value === UI.P.dex[v.name].a) delete v.ability; else v.ability = t.value; }, { keepSelection: true });
  if (k === "passive" && u) return change(b => { const v = b.units.find(w => w.id === u.id); if (t.checked) delete v.passive; else v.passive = "NONE"; }, { keepSelection: true });
  if (k === "stat" && u) {
    const stat = t.dataset.stat, value = Number(t.value), def = baseStats(UI.P.dex[u.name])[stat];
    if (!Number.isFinite(value)) return renderDetails();
    return change(b => { const v = b.units.find(w => w.id === u.id); if (value === def) delete v.stats[stat]; else v.stats[stat] = value; }, { keepSelection: true });
  }
  if (k === "syn-level") return change(b => { b.syn[S.synTeam].levels[t.dataset.syn] = Number(t.value); });
  if (k === "syn-on") return change(b => { const c = b.syn[S.synTeam]; c.off = t.checked ? c.off.filter(s => s !== t.dataset.syn) : [...new Set([...c.off, t.dataset.syn])]; });
  if (k === "syn-thr") {
    const values = t.value.split(/[\s,;]+/).map(Number).filter(n => n > 0 && n < 100).sort((a, b) => a - b);
    const game = UI.own.SynergyTiersThresholds?.[t.dataset.syn] || [];
    return change(b => { if (!values.length || values.join() === game.join()) delete b.syn[S.synTeam].thresholds[t.dataset.syn]; else b.syn[S.synTeam].thresholds[t.dataset.syn] = values; });
  }
  if (k === "syn-all") { S.showAllSyn = t.checked; return renderSynergies(); }
  if (k === "compare-n") { S.compare = { ...(S.compare || {}), n: clamp(Math.round(Number(t.value) || 20), 1, 200) }; return; }
  if (k === "compare-board") {
    const boards = new Set(S.compare?.boards || []);
    if (t.checked) boards.add(t.value); else boards.delete(t.value);
    S.compare = { ...(S.compare || {}), boards: [...boards] };
  }
}

function onBoardKey(e) {
  const cell = e.target.closest?.("[data-cell]");
  if (!cell) return;
  const [x, y] = cell.dataset.cell.split(",").map(Number);
  const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  if (moves[e.key]) {
    e.preventDefault();
    const nx = clamp(x + moves[e.key][0], 0, S.board.cols - 1), ny = clamp(y + moves[e.key][1], 0, S.board.rows - 1);
    const u = unitAt(x, y);
    // Alt + arrow carries the Pokémon along
    if (e.altKey && u) { moveUnit(u.id, nx, ny); S.focus = [nx, ny]; focusCell(nx, ny); return; }
    S.focus = [nx, ny];
    return focusCell(nx, ny);
  }
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); return clickCell(x, y); }
}
function focusCell(x, y) {
  UI.root.querySelectorAll("[data-cell]").forEach(c => { c.tabIndex = -1; });
  const c = UI.root.querySelector(`[data-cell="${x},${y}"]`);
  if (c) { c.tabIndex = 0; c.focus({ preventScroll: true }); }
}
function onGlobalKey(e) {
  if (!UI?.host.isConnected) return;
  const typing = e.target.closest?.("input, select, textarea, [contenteditable]");
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !typing && e.key.toLowerCase() === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && !typing && e.key.toLowerCase() === "y") { e.preventDefault(); return redo(); }
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); return save(); }
  if (e.key === "Escape") {
    closeMenu();
    if (S.armed) { S.armed = null; renderPickerList(); renderBoard(); if (S.tab === "items") renderItems(); return; }
    if (S.selected) { S.selected = null; renderBoard(); renderRight(); }
    return;
  }
  if (typing || document.querySelector("dialog[open]")) return;
  if ((e.key === "Delete" || e.key === "Backspace") && S.selected && S.mode === "edit") { e.preventDefault(); return removeUnit(S.selected); }
  if (e.key === " " && S.mode === "fight" && S.result) { e.preventDefault(); return Playback.toggle(); }
}

/* ---------- drag and drop ----------
   Pointer events, so mouse, pen and touch all work. With a mouse, dragging starts after a few pixels; with touch,
   Pokémon on the board can be dragged (the board doesn't scroll), while lists scroll as usual and are tapped
   instead. Holding a Pokémon on the board opens its menu. */
const Drag = { active: null, suppressClick: false };
function onPointerDown(e) {
  if (e.button > 0 || S.mode === "fight") return;
  const src = e.target.closest("[data-drag]");
  if (!src) return;
  const kind = src.dataset.drag;
  const touch = e.pointerType === "touch";
  if (touch && kind !== "unit") return;  // lists keep scrolling on touch: tap instead
  const payload = kind === "unit" ? { kind, id: src.dataset.unit } : kind === "pokemon" ? { kind, name: src.dataset.pick } : { kind, item: src.dataset.gear };
  const d = Drag.active = { payload, src, x0: e.clientX, y0: e.clientY, id: e.pointerId, started: false, touch, ghost: null, over: null };
  if (touch) d.hold = setTimeout(() => {
    if (Drag.active !== d || d.started) return;
    endDrag();
    Drag.suppressClick = true;  // (the tap that lifting the finger makes)
    setTimeout(() => { Drag.suppressClick = false; }, 600);
    openUnitMenu(src, e.clientX, e.clientY);
  }, 550);
  src.addEventListener("pointermove", onPointerMove);
  src.addEventListener("pointerup", onPointerUp);
  src.addEventListener("pointercancel", onPointerCancel);
  try { src.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
}
function onPointerMove(e) {
  const d = Drag.active;
  if (!d || e.pointerId !== d.id) return;
  if (!d.started) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < (d.touch ? 8 : 5)) return;
    d.started = true;
    clearTimeout(d.hold);
    const art = d.payload.kind === "item" ? itemIcon(d.payload.item, 32) : portraitOf(d.payload.kind === "unit" ? unitById(d.payload.id)?.name : d.payload.name, 48);
    d.ghost = document.createElement("div");
    d.ghost.className = "pb-ghost";
    d.ghost.innerHTML = art;
    document.body.append(d.ghost);
    document.body.classList.add("pb-dragging");
    if (d.payload.kind === "unit") { UI.root.querySelector("#pb-trash").hidden = false; d.src.classList.add("lifted"); }
  }
  e.preventDefault();
  d.ghost.style.transform = `translate(${e.clientX - 24}px, ${e.clientY - 24}px)`;
  const under = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop], .pb-left, [data-body='pokemon']");
  if (under !== d.over) {
    d.over?.classList.remove("drop-on");
    d.over = under;
    under?.classList.add("drop-on");
  }
}
function onPointerUp(e) {
  const d = Drag.active;
  if (!d || e.pointerId !== d.id) return;
  const started = d.started, over = d.over;
  endDrag();
  if (!started) return;
  Drag.suppressClick = true;
  setTimeout(() => { Drag.suppressClick = false; }, 0);
  drop(d.payload, over);
}
function onPointerCancel() { endDrag(); }
function endDrag() {
  const d = Drag.active;
  if (!d) return;
  clearTimeout(d.hold);
  d.src.removeEventListener("pointermove", onPointerMove);
  d.src.removeEventListener("pointerup", onPointerUp);
  d.src.removeEventListener("pointercancel", onPointerCancel);
  d.src.classList.remove("lifted");
  d.over?.classList.remove("drop-on");
  d.ghost?.remove();
  document.body.classList.remove("pb-dragging");
  const trash = UI?.root.querySelector("#pb-trash");
  if (trash) trash.hidden = true;
  Drag.active = null;
}
function drop(p, target) {
  if (!target) return;
  const cellKey = target.dataset?.cell;
  if (target.dataset?.drop === "trash" || (!cellKey && p.kind === "unit")) {
    if (p.kind === "unit") removeUnit(p.id);
    return;
  }
  if (!cellKey) return;
  const [x, y] = cellKey.split(",").map(Number);
  if (p.kind === "pokemon") return place(p.name, x, y);
  if (p.kind === "unit") return moveUnit(p.id, x, y);
  if (p.kind === "item") {
    const u = unitAt(x, y);
    if (u) giveItem(u.id, p.item); else toast("Drop items onto a Pokémon");
  }
}

/* ---------- menus, dialogs, messages ---------- */
function onContextMenu(e) {
  const cell = e.target.closest("[data-cell]");
  if (!cell || S.mode === "fight") return;
  e.preventDefault();
  const [x, y] = cell.dataset.cell.split(",").map(Number);
  openUnitMenu(cell, e.clientX, e.clientY, [x, y]);
}
function openUnitMenu(el, cx, cy, at) {
  const cell = el.closest("[data-cell]");
  const [x, y] = at || cell.dataset.cell.split(",").map(Number);
  const u = unitAt(x, y);
  const entries = u ? [
    ["Details", () => { S.selected = u.id; S.tab = "details"; renderBoard(); renderRight(); }],
    ["Copy to a free cell", () => duplicateUnit(u.id)],
    ["Move to the other side", () => flipUnit(u.id)],
    ...(u.items.length ? [["Take off its items", () => change(b => { b.units.find(v => v.id === u.id).items = []; }, { keepSelection: true })]] : []),
    ...(Object.keys(u.stats).length || u.ability || u.passive != null ? [["Back to the game's stats", () => change(b => { const v = b.units.find(w => w.id === u.id); v.stats = {}; delete v.ability; delete v.passive; }, { keepSelection: true })]] : []),
    ["Remove", () => removeUnit(u.id), "danger"],
  ] : [
    ...(S.armed?.kind === "pokemon" ? [[`Place ${pkName(S.armed.name)}`, () => place(S.armed.name, x, y)]] : []),
    ["Choose a Pokémon for this cell…", () => { S.focus = [x, y]; if (!UI.wide.matches) { S.tab = "pokemon"; renderRight(); } UI.picker.querySelector("[data-in='pk-q']").focus(); }],
  ];
  showMenu(cx, cy, entries, u ? pkName(u.name) : `Empty cell ${x + 1}, ${y + 1}`);
}
function showMenu(x, y, entries, title) {
  closeMenu();
  const m = document.createElement("div");
  m.className = "pb-menu";
  m.setAttribute("role", "menu");
  m.innerHTML = `<div class="pb-menu-t">${esc(title)}</div>` + entries.map(([label, , cls], i) => `<button role="menuitem" class="${cls || ""}" data-i="${i}">${esc(label)}</button>`).join("");
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  m.addEventListener("click", ev => { const b = ev.target.closest("[data-i]"); if (!b) return; closeMenu(); entries[Number(b.dataset.i)][1](); });
  m.querySelector("button[data-i]")?.focus();
  setTimeout(() => document.addEventListener("pointerdown", closeMenuOutside, true), 0);
}
function closeMenuOutside(e) { if (!e.target.closest(".pb-menu")) closeMenu(); }
function closeMenu() {
  document.querySelectorAll(".pb-menu").forEach(m => m.remove());
  document.removeEventListener("pointerdown", closeMenuOutside, true);
}
// Choosing an item for the picked Pokémon from a searchable list
function itemMenu(anchor, id) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const m = document.createElement("div");
  m.className = "pb-menu pb-imenu";
  m.innerHTML = `<input type="search" class="pb-input" placeholder="Search items…" aria-label="Search items"><div class="pb-imenu-list"></div>`;
  document.body.append(m);
  const list = m.querySelector(".pb-imenu-list"), input = m.querySelector("input");
  const fill = () => {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = UI.itemGroups.map(g => {
      const items = g.items.filter(i => !q || itemName(i).toLowerCase().includes(q));
      return items.length ? `<div class="eyebrow">${esc(g.label)}</div>` + items.map(i => `<button data-item="${i}">${itemIcon(i, 22)}<span>${esc(itemName(i))}</span></button>`).join("") : "";
    }).join("") || `<div class="empty-note">No items match.</div>`;
  };
  fill();
  input.addEventListener("input", fill);
  list.addEventListener("click", ev => { const b = ev.target.closest("[data-item]"); if (!b) return; closeMenu(); giveItem(id, b.dataset.item); });
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 300))}px`;
  m.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - 380))}px`;
  input.focus();
  setTimeout(() => document.addEventListener("pointerdown", closeMenuOutside, true), 0);
}

function dialog(html, { wide = false } = {}) {
  let d = document.getElementById("pb-dialog");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "pb-dialog";
    d.className = "pb-dialog";
    document.body.append(d);
    // a click outside it (on the backdrop) is a cancel
    d.addEventListener("click", e => { if (e.target === d) { d.dispatchEvent(new Event("pb-dismiss")); if (d.open) d.close("cancel"); } });
  }
  d.classList.toggle("wide", wide);
  d.onclick = null;
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
}
// A dialog with a form: resolves with the value of the button pressed ("cancel" for Esc or a click outside), once
// it has closed. (It goes by the form's own submit rather than the dialog's close event, which some browsers hold
// back while the page isn't being drawn.)
function ask(html, options) {
  const d = dialog(html, options);
  return new Promise(resolve => {
    const finish = value => {
      d.removeEventListener("submit", onSubmit);
      d.removeEventListener("cancel", onCancel);
      d.removeEventListener("pb-dismiss", onCancel);
      if (d.open) d.close(value);
      resolve(value);
    };
    const onSubmit = e => { e.preventDefault(); finish(e.submitter?.value || "ok"); };
    const onCancel = e => { e.preventDefault(); finish("cancel"); };
    d.addEventListener("submit", onSubmit);
    d.addEventListener("cancel", onCancel);
    d.addEventListener("pb-dismiss", onCancel);
  });
}
async function confirmBox(title, text, ok = "OK", { danger = false } = {}) {
  const answer = ask(`<form method="dialog"><h3>${esc(title)}</h3><p>${text}</p><div class="pb-dbtns">
    <button class="btn" value="cancel">Cancel</button><button class="btn ${danger ? "red" : "primary"}" value="ok">${esc(ok)}</button></div></form>`);
  document.querySelector('#pb-dialog [value="ok"]')?.focus();
  return (await answer) === "ok";
}
function messageBox(title, text) {
  ask(`<form method="dialog"><h3>${esc(title)}</h3><p>${text}</p><div class="pb-dbtns"><button class="btn primary" value="ok">OK</button></div></form>`);
}
function toast(text, { undo: withUndo = false } = {}) {
  let t = document.getElementById("pb-toast");
  if (!t) { t = document.createElement("div"); t.id = "pb-toast"; t.className = "pb-toast"; t.setAttribute("role", "status"); document.body.append(t); }
  t.innerHTML = `<span>${esc(text)}</span>${withUndo ? `<button class="linkish" id="pb-toast-undo">Undo</button>` : ""}`;
  t.classList.add("on");
  t.querySelector("#pb-toast-undo")?.addEventListener("click", () => { undo(); t.classList.remove("on"); });
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("on"), 4500);
}

function savesDialog() {
  const list = Saves.list();
  const d = dialog(`<h3>Your boards</h3><p class="muted">Kept in this browser. Export a board to move it to another device or share it.</p>
    <div class="pb-saves">${list.length ? list.map(b => `<div class="pb-save ${b.id === S.board.id ? "current" : ""}">
      <div class="pb-save-mons">${(b.units || []).slice(0, 6).map(u => UI.P.dex[u.name] ? portraitOf(u.name, 28) : "").join("")}</div>
      <div class="pb-save-n"><b>${esc(b.name)}</b><span class="muted">${(b.units || []).length} Pokémon · ${b.cols}×${b.rows} · ${euDate(b.updated)} ${clock(b.updated)}${b.id === S.board.id ? " · open now" : ""}</span></div>
      <div class="pb-save-b"><button class="btn" data-sv="open" data-id="${esc(b.id)}">Open</button><button class="btn icon" data-sv="copy" data-id="${esc(b.id)}" title="Copy" aria-label="Copy">${icon("copy")}</button>
        <button class="btn icon" data-sv="export" data-id="${esc(b.id)}" title="Export" aria-label="Export">${icon("download")}</button><button class="btn icon danger" data-sv="delete" data-id="${esc(b.id)}" title="Delete" aria-label="Delete">${icon("trash")}</button></div>
    </div>`).join("") : `<div class="empty-note">No saved boards yet. Press Save to keep the one you're working on.</div>`}</div>
    <div class="pb-dbtns"><button class="btn" data-sv="import">${icon("upload")}<span>Import a file</span></button><button class="btn primary" data-sv="close">Close</button></div>`, { wide: true });
  d.onclick = async e => {
    if (e.target === d) return d.close();
    const b = e.target.closest("[data-sv]");
    if (!b) return;
    const board = b.dataset.id && Saves.get(b.dataset.id);
    const what = b.dataset.sv;
    if (what === "close") return d.close();
    if (what === "import") { d.close(); return importBoard(); }
    if (!board) return;
    if (what === "open") { d.close(); return openBoard(cleanBoard(board, UI.known), { saved: true }); }
    if (what === "export") return exportBoard(board);
    if (what === "copy") { const copy = { ...board, id: uid(), name: `${board.name} (copy)`.slice(0, 60), updated: Date.now() }; Saves.put(copy); return savesDialog(); }
    if (what === "delete") {
      if (await confirmBox(`Delete "${board.name}"?`, "It's gone from this browser for good (export it first to keep a copy).", "Delete")) {
        Saves.remove(board.id);
        if (board.id === S.board.id) { S.saved = null; afterChange(); }
      }
      return savesDialog();
    }
  };
}

async function settingsDialog() {
  const s = S.board.settings, b = S.board;
  const weathers = ["NEUTRAL", ...UI.known.weathers.filter(w => w !== "NEUTRAL")];
  const answer = ask(`<form method="dialog" class="pb-settings"><h3>Sandbox settings <span class="muted">for this board</span></h3>
    <fieldset><legend>Board</legend>
      <label>Columns <input class="pb-input num" type="number" name="cols" min="${COLS[0]}" max="${COLS[1]}" value="${b.cols}"></label>
      <label>Rows per side <input class="pb-input num" type="number" name="side" min="${SIDE_ROWS[0]}" max="${SIDE_ROWS[1]}" value="${b.rows / 2}"></label>
      <span class="muted">The game's board is 8 columns and 3 rows per side.</span></fieldset>
    <fieldset><legend>Fight</legend>
      <label>Stage <input class="pb-input num" type="number" name="stage" min="1" max="60" value="${s.stage}"></label>
      <label>Weather <select class="pb-input" name="weather">${weathers.map(w => `<option value="${w}" ${w === s.weather ? "selected" : ""}>${esc(titleCase(w))}</option>`).join("")}</select></label>
      <span class="muted">Some effects grow with the stage. In a game the weather comes from both boards' synergies; here you choose it.</span></fieldset>
    <fieldset><legend>Items</legend>
      <label class="pb-check"><input type="checkbox" name="limit" ${s.itemLimit ? "checked" : ""}><span>At most 3 items a Pokémon, like the game</span></label>
      <label class="pb-check"><input type="checkbox" name="combine" ${s.combine ? "checked" : ""}><span>Two components make an item, like the game</span></label></fieldset>
    <div class="pb-dbtns"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Apply</button></div></form>`);
  const f = document.querySelector("#pb-dialog form");
  if ((await answer) !== "ok") return;
  const cols = clamp(Math.round(Number(f.cols.value) || 8), ...COLS), rows = 2 * clamp(Math.round(Number(f.side.value) || 3), ...SIDE_ROWS);
  const settings = { stage: clamp(Math.round(Number(f.stage.value) || 20), 1, 60), weather: f.weather.value,
    itemLimit: f.limit.checked ? 3 : 0, combine: f.combine.checked };
  // each side keeps its rows counted from its own back row, as the game counts them
  const fromBack = u => u.team === "blue" ? u.y : b.rows - 1 - u.y;
  const lost = b.units.filter(u => u.x >= cols || fromBack(u) >= rows / 2).length;
  if (lost && !(await confirmBox("Make the board smaller?", `${lost} Pokémon would be outside it and come off.`, "Make it smaller"))) return;
  change(board => {
    board.units = board.units.filter(u => u.x < cols && fromBack(u) < rows / 2);
    board.units.forEach(u => { if (u.team === "red") u.y = rows - 1 - fromBack(u); });
    board.cols = cols;
    board.rows = rows;
    Object.assign(board.settings, settings);
    if (board.settings.itemLimit) board.units.forEach(u => { u.items = u.items.slice(0, 3); });
  });
}

/* ================================================================ fights: running and watching ================ */
// What the last fight was run on: when this changes, the fight shown is out of date
const fightKey = () => JSON.stringify({ units: S.board.units, syn: S.board.syn, s: S.board.settings, c: S.board.cols, r: S.board.rows });
function fightInput(board) {
  const keep = S.board;
  S.board = board;
  try { return { blue: teamInput("blue"), red: teamInput("red") }; } finally { S.board = keep; }
}
function runAndShow() {
  const b = S.board;
  if (!b.units.some(u => u.team === "blue") || !b.units.some(u => u.team === "red")) {
    return toast("Put at least one Pokémon on each side first");
  }
  let R;
  try {
    R = runFight(UI.E, b, fightInput(b), { seed: b.settings.seed });
  } catch (err) {
    console.error(err);
    return messageBox("The fight couldn't run", esc(err.message));
  }
  S.result = { R, key: fightKey(), seed: b.settings.seed };
  S.logLimit = 300;
  if (R.notes.length) console.warn("Fight notes:", R.notes, R.errors);
  setMode("fight", { restart: true });
}
function setMode(mode, { restart = false } = {}) {
  if (mode === "fight" && !S.result) return runAndShow();
  const was = S.mode;
  S.mode = mode;
  if (mode === "fight") {
    if (restart || was !== "fight" || !Playback.game) Playback.open(UI.root.querySelector("#pb-battle"), S.result.R);
  } else {
    Playback.close();
  }
  refresh();
}

// Each board many times with different seeds (a little at a time, so the page keeps responding)
async function runCompare() {
  const n = S.compare?.n || 20;
  const boards = [S.board, ...(S.compare?.boards || []).map(id => Saves.get(id)).filter(Boolean).map(b => cleanBoard(b, UI.known))];
  S.compare = { ...(S.compare || {}), n, running: true, done: 0, total: n * boards.length, rows: [] };
  renderBottom();
  for (const b of boards) {
    const row = { name: b.id === S.board.id ? `${b.name} (open now)` : b.name, n: 0, blue: 0, red: 0, draw: 0, time: 0, blueLeft: 0, redLeft: 0 };
    S.compare.rows.push(row);
    if (!b.units.some(u => u.team === "blue") || !b.units.some(u => u.team === "red")) { row.name += " — needs Pokémon on both sides"; S.compare.done += n; continue; }
    const input = fightInput(b);
    for (let i = 0; i < n; i++) {
      const R = runFight(UI.E, b, input, { seed: b.settings.seed + i, record: false });
      row.n++; row[R.winner]++; row.time += R.duration;
      row.blueLeft += R.stats.filter(s => s.team === "blue" && s.survived && s.unit).length;
      row.redLeft += R.stats.filter(s => s.team === "red" && s.survived && s.unit).length;
      S.compare.done++;
      if (i % 4 === 3) {
        if (S.bottom === "compare" && UI.host.isConnected) renderBottom();
        await new Promise(r => setTimeout(r, 0));
        if (!UI.host.isConnected) return;
      }
    }
  }
  S.compare.running = false;
  if (UI.host.isConnected) renderBottom();
}

/* ---------- watching a fight ----------
   The fight is worked out first (in a moment), then played back: where everyone stands, their HP and statuses come
   from the recorded ticks, so the replay can be paused, sped up and scrubbed; attacks, casts, numbers and
   knockouts are shown as the replay passes them. */
const Playback = {
  game: null, scene: null, R: null, t: 0, playing: false, speed: 1,
  open(host, R) {
    this.close();
    this.R = R; this.t = 0; this.playing = true;
    host.innerHTML = `<div class="empty-note">Loading the animations…</div>`;
    const b = S.board;
    Promise.all([loadPhaser(), loadStageData()]).then(async ([Phaser, SD]) => {
      if (this.R !== R || !host.isConnected) return;
      const Scene = battleScene(Phaser, SD, R, b, this);
      await snapshotSprites(Scene.sprites);
      if (this.R !== R || !host.isConnected) return;
      host.innerHTML = "";
      host.style.aspectRatio = `960 / ${Scene.height}`;
      this.game = new Phaser.Game({
        type: Phaser.AUTO, parent: host, width: 960, height: Scene.height, backgroundColor: "#0f1215", pixelArt: true,
        banner: false, audio: { noAudio: true }, loader: { crossOrigin: "anonymous" },
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, scene: Scene,
      });
      STAGE = this.game;  // (the site stops it when someone leaves the page)
    }).catch(err => {
      if (host.isConnected) host.innerHTML = `<div class="empty-note">The animations couldn't be loaded (${esc(err.message)}). The fight's numbers are below.</div>`;
    });
  },
  close() {
    if (this.game) {
      if (STAGE === this.game) STAGE = null;
      try { this.game.destroy(true); } catch { /* already stopped by the site */ }
    }
    this.game = null; this.scene = null; this.R = null;
  },
  toggle() { this.playing ? this.pause() : this.play(); },
  play() { if (this.R && this.t >= this.R.duration) this.seek(0, true); this.playing = true; this.scene?.setPlaying(true); this.ui(); },
  pause() { if (!this.playing) return; this.playing = false; this.scene?.setPlaying(false); this.ui(); },
  seek(t, keepPlaying) {
    if (!this.R) return;
    this.t = clamp(t, 0, this.R.duration);
    this.scene?.jump(this.t);
    if (!keepPlaying) this.pause();
    this.tick(this.t, true);
  },
  step() { this.pause(); this.scene?.advance(100); },
  setSpeed(s) { this.speed = s; this.scene?.setSpeed(s); this.ui(); },
  // the controls follow the replay in place (play button, speed, time, slider), so a slider being dragged stays put
  ui() {
    const root = UI?.root;
    if (!root?.isConnected) return;
    const toggle = root.querySelector('[data-act="toggle-play"]');
    if (toggle) {
      toggle.innerHTML = icon(this.playing ? "pause" : "play");
      toggle.title = `${this.playing ? "Pause" : "Play"} (Space)`;
      toggle.setAttribute("aria-label", this.playing ? "Pause" : "Play");
    }
    root.querySelectorAll('[data-act="speed"]').forEach(b => b.classList.toggle("on", Number(b.dataset.speed) === this.speed));
  },
  tick(t, now_ = false) {
    this.t = t;
    const now = performance.now();
    if (!now_ && now - (this.lastTick || 0) < 120) return;
    this.lastTick = now;
    const time = UI?.root.querySelector("#pb-time"), scrub = UI?.root.querySelector(".pb-scrub");
    if (time) time.textContent = `${fmtTime(t)} / ${fmtTime(this.R.duration)}`;
    if (scrub && document.activeElement !== scrub) scrub.value = Math.round(t);
  },
  ended() { this.playing = false; this.ui(); },
};

function battleScene(Phaser, SD, R, board, playback) {
  const Kit = sceneKit(Phaser, SD);
  const own = ENGINE.own;
  const frames = R.frames, cast = fightCast(R);
  const lib = animationLibrary(SD, Phaser);
  // Who's in it, from the first tick they're in
  const people = new Map();
  frames.forEach((f, i) => f.units.forEach(u => { if (!people.has(u.id)) people.set(u.id, { id: u.id, name: u.name, idx: u.index, team: u.team, first: i, start: [u.x, u.y] }); }));
  // Their moves (each change of cell, glided over the game's time for it) and attacks, from tick to tick
  const moveSpeed = speed => 0.5 + (speed || 0) / 100;
  const visuals = [];
  for (const p of people.values()) p.moves = [];
  for (let i = 1; i < frames.length; i++) {
    const before = new Map(frames[i - 1].units.map(u => [u.id, u]));
    for (const u of frames[i].units) {
      const was = before.get(u.id);
      if (!was) continue;
      const p = people.get(u.id);
      if (was.alive && (was.x !== u.x || was.y !== u.y)) {
        const dx = u.x - was.x, dy = u.y - was.y;
        p.moves.push({ t: frames[i].t, from: [was.x, was.y], to: [u.x, u.y],
          dur: 1000 * Math.hypot(dx, dy) / (2 * moveSpeed(u.speed) * Math.max(Math.abs(dx), Math.abs(dy))) });
      }
      if (u.attacks > was.attacks && u.alive) visuals.push({ t: frames[i].t, kind: "attack", id: u.id, target: u.target, speed: u.speed, index: u.index, name: u.name });
      if (was.alive && !u.alive) visuals.push({ t: frames[i].t, kind: "ko", id: u.id });
    }
  }
  for (const e of R.log) {
    if (e.kind === "cast") visuals.push({ ...e, kind: "cast" });
    else if (e.kind === "damage" && e.amount > 0) visuals.push({ ...e, kind: "damage" });
    else if (e.kind === "heal") visuals.push({ ...e, kind: "heal" });
  }
  visuals.sort((a, b) => a.t - b.t);
  const indices = [...new Set([...people.values()].map(p => p.idx))];
  // The camera holds the whole board
  const corners = [[0, 0], [board.cols - 1, board.rows - 1]].map(([x, y]) => transformEntityCoordinates(x, y, false));
  const left = corners[0][0] - CELL * 0.75, right = corners[1][0] + CELL * 0.75;
  const top = corners[1][1] - CELL * 0.9, bottom = corners[0][1] + CELL * 0.8;
  const height = Math.round(960 * (bottom - top) / (right - left));

  return class Battle extends Kit {
    static height = height;
    static sprites = indices;
    constructor() { super("battle"); }
    preload() {
      this.loadEffects();
      indices.forEach(idx => { this.loadSprite(idx); this.loadPortrait(idx); });
    }
    create() {
      playback.scene = this;
      this.createEffectAnimations();
      this.abilitiesVfxGroup = this.add.group();
      for (let x = 0; x < board.cols; x++) for (let y = 0; y < board.rows; y++) {
        const [px, py] = transformEntityCoordinates(x, y, false);
        if (this.textures.exists("board_cell")) this.add.image(px, py, "board_cell", (x + y) % 2).setScale(3).setDepth(DEPTH.GROUND).setAlpha(0.5);
        else this.add.rectangle(px, py, CELL, CELL, (x + y) % 2 ? 0x2a2f35 : 0x23272c).setDepth(DEPTH.GROUND);
        this.add.rectangle(px, py, CELL, CELL, y < board.rows / 2 ? 0x4d62e5 : 0xf03a38, 0.06).setDepth(DEPTH.GROUND);
      }
      this.units = new Map();
      for (const p of people.values()) {
        const cfg = { ...SD.default, ...(SD.pokemon[p.name] || {}) }, timings = SD.frames[p.idx] || {};
        const facing = p.team === "blue" ? "4" : "0";
        const anims = this.createPokemonAnimations(p.idx, cfg, timings, facing);
        const unit = this.unit({ id: p.id, idx: p.idx, cfg, timings, anims, cell: p.start, speed: 0 });
        unit.facing = facing;
        unit.person = p;
        unit.bar = { g: this.add.graphics({ x: unit.xy[0], y: unit.xy[1] + 25 }).setDepth(DEPTH.POKEMON_HP_BAR), hp: 1, maxHp: 1, shield: 0, pp: 0, maxPP: 0, ally: p.team === "blue" };
        unit.shown = {};
        this.units.set(p.id, unit);
      }
      this.cameras.main.setZoom(960 / (right - left)).centerOn((left + right) / 2, (top + bottom) / 2);
      this.t = playback.t;
      this.frame = -1;
      this.next = 0;
      this.setSpeed(playback.speed);
      this.jump(this.t);
      this.setPlaying(playback.playing);
    }
    setPlaying(on) {
      this.playing = on;
      if (on) { this.anims.resumeAll(); this.tweens.resumeAll(); this.time.paused = false; }
      else { this.anims.pauseAll(); this.tweens.pauseAll(); this.time.paused = true; }
    }
    setSpeed(s) {
      this.speed = s;
      this.anims.globalTimeScale = s;
      this.tweens.timeScale = s;
      this.time.timeScale = s;
    }
    update(time, delta) {
      if (!this.playing || this.outro) return;
      this.advance(Math.min(delta, 100) * this.speed);
    }
    // Moves the replay on, showing what happens on the way
    advance(ms) {
      const t = Math.min(R.duration, this.t + ms);
      while (this.next < visuals.length && visuals[this.next].t <= t) this.show(visuals[this.next++]);
      this.t = t;
      this.place(t);
      playback.tick(t);
      if (t >= R.duration && this.playing && !this.outro) {
        // The fight's last tick is usually the last knockout: its hurt animation and fade, and the last numbers,
        // play out before the replay stops. The ones left standing keep idling after.
        this.outro = this.time.delayedCall(OUTRO, () => {
          this.outro = null;
          this.playing = false;
          this.time.paused = true;
          playback.ended();
        });
      }
    }
    // Straight to a moment, without replaying what happened before it
    jump(t) {
      this.outro?.remove(false);
      this.outro = null;
      this.t = t;
      this.next = visuals.findIndex(v => v.t > t);
      if (this.next < 0) this.next = visuals.length;
      for (const unit of this.units.values()) {
        for (const key of Object.keys(unit.shown)) { this.setStatus(unit, key, 0, unit.shown[key]); }
        unit.shown = {};
        unit.busyUntil = 0;
        unit.anim = null;
        if (unit.fading) {
          unit.fading = false;
          this.unitParts(unit).forEach(([part]) => { this.tweens.killTweensOf(part); part.setAlpha(1); });
        }
      }
      this.frame = -1;
      this.place(t);
      playback.tick(t);
    }
    // Everyone where they are at time t: cell (gliding between cells), facing, life bar, statuses, still standing
    place(t) {
      const fi = Math.min(frames.length - 1, Math.max(0, Math.floor(t / TICK + 1e-6)));
      const frame = frames[fi], newFrame = fi !== this.frame;
      this.frame = fi;
      const now = new Map(frame.units.map(u => [u.id, u]));
      for (const unit of this.units.values()) {
        const u = now.get(unit.id), p = unit.person;
        const present = u && fi >= p.first && (u.alive || unit.fading);
        const visible = present && !u?.skydiving;
        if (!visible) { this.unitParts(unit).forEach(([part]) => part.setVisible(false)); if (!present) continue; }
        // where: the last move started before t, part of the way if it's still going
        let cell = p.start, moving = null;
        for (let i = p.moves.length - 1; i >= 0; i--) {
          const m = p.moves[i];
          if (m.t > t) continue;
          const k = Math.min(1, (t - m.t) / m.dur);
          cell = [m.from[0] + (m.to[0] - m.from[0]) * k, m.from[1] + (m.to[1] - m.from[1]) * k];
          if (k < 1) moving = m;
          break;
        }
        const [x, y] = transformEntityCoordinates(cell[0], cell[1], false);
        unit.xy = [x, y];
        unit.cell = [Math.round(cell[0]), Math.round(cell[1])];
        this.setRow(unit);
        if (visible) this.unitParts(unit).forEach(([part, dx, dy]) => part.setPosition(x + dx, y + dy).setVisible(true));
        if (unit.fading) continue;
        // facing and what it's doing: walking while it glides, otherwise idle the way it faces (attacks and casts play over it)
        const facing = moving ? sectorOf(moving.from, moving.to) : ORIENTATION_DIGITS[u.orientation] ?? unit.facing;
        const want = moving ? "walk" : "idle";
        if (t >= (unit.busyUntil || 0) && (unit.anim !== want || unit.facing !== facing)) {
          unit.facing = facing;
          unit.anim = want;
          this.animate(unit, want, facing);
        }
        if (newFrame) {
          const bar = unit.bar;
          if (bar.hp !== u.hp || bar.maxHp !== u.maxHP || bar.shield !== u.shield || bar.pp !== u.pp || bar.maxPP !== u.maxPP) {
            Object.assign(bar, { hp: u.hp, maxHp: Math.max(1, u.maxHP), shield: u.shield, pp: u.pp, maxPP: u.maxPP });
            this.drawBar(bar);
          }
          for (const key of STATUS_KEYS) {
            const value = u.status[key], was = unit.shown[key] || 0;
            if (Boolean(value) !== Boolean(was) || (key === "poisonStacks" && value !== was)) {
              this.setStatus(unit, key, value, was);
              unit.shown[key] = value;
            }
          }
        }
      }
    }
    // One thing happening, as the game's client shows it
    show(v) {
      if (v.kind === "attack") return this.showAttack(v);
      if (v.kind === "cast") {
        const unit = this.units.get(v.by);
        if (unit) {
          const facing = ORIENTATION_DIGITS[v.orientation] ?? unit.facing;
          const dur = this.animate(unit, unit.anims.ability ? "ability" : "attack", facing);
          unit.busyUntil = this.t + dur;  // (fight time: animations run at the replay's speed too)
          unit.anim = null;
        }
        this.playAbility({ skill: v.skill, positionX: v.x, positionY: v.y, targetX: v.tx, targetY: v.ty, orientation: v.orientation,
          delay: v.delay, data: v.data, ap: v.ap });
        return;
      }
      if (v.kind === "damage" || v.kind === "heal") {
        const target = this.units.get(v.to);
        if (!target) return;
        const by = cast[v.from];
        const [x, y] = target.xy;
        this.floatNumber(x, y, v.amount, v.kind === "heal" ? NUMBER_COLORS.HEAL : NUMBER_COLORS[v.type] || NUMBER_COLORS.SPECIAL,
          { key: by ? `portrait-${by.index}` : "" });
        return;
      }
      if (v.kind === "ko") {
        const unit = this.units.get(v.id);
        if (!unit) return;
        unit.fading = true;
        if (unit.anims.hurt) this.animate(unit, "hurt", unit.facing);
        this.unitParts(unit).forEach(([part]) => this.tweens.add({ targets: part, alpha: 0, duration: 500,
          onComplete: () => { part.setVisible(false); part.setAlpha(1); unit.fading = false; } }));
      }
    }
    // A basic attack (attacking-state.ts): its animation sped up to the attack speed, then the game's attack
    // sprite: a projectile for ranged Pokémon, a hit on the target for melee ones, at the game's timings
    showAttack(v) {
      const unit = this.units.get(v.id), target = this.units.get(v.target);
      if (!unit) return;
      const cooldown = 1000 / (0.4 + (v.speed || 0) * 0.007);
      const cfg = unit.cfg, frames36 = (unit.timings[cfg.attack] || []).reduce((a, b) => a + b, 0);
      const dur = this.animate(unit, "attack", unit.facing, frames36 ? Math.max(1, (frames36 / 36) / (cooldown / 1000)) : 1);
      unit.busyUntil = this.t + dur;
      unit.anim = null;
      if (!target) return;
      const delays = own.delays?.[v.index] || {};
      const delayBeforeShoot = Math.min(cooldown / 2, cooldown * (delays.d || 18) / (delays.t || 36));
      const sprite = (cfg.attackSprite || "NORMAL/melee").replace("DRAGON_GREEN", "DRAGON");
      const frame = `${sprite}/000.png`, scale = SD.spriteScale[cfg.attackSprite || "NORMAL/melee"] || [1, 1];
      const hit = cfg.hitSprite || ["NORMAL/hit"];
      const has = this.textures.get("attacks")?.has?.(frame) && this.anims.exists(sprite);
      this.time.delayedCall(delayBeforeShoot, () => {
        if (!this.sys?.isActive()) return;
        const [ux, uy] = unit.xy, [tx, ty] = target.xy;
        if (sprite.endsWith("/range") && has) {
          const cells = Math.max(Math.abs(unit.cell[0] - target.cell[0]), Math.abs(unit.cell[1] - target.cell[1]));
          const travel = cells * 1000 / ((own.BASE_PROJECTILE_SPEED || 4) * (1 + (v.speed || 0) / 100));
          const p = this.add.sprite(ux, uy - 10, "attacks", frame).setScale(...scale).setDepth(DEPTH.PROJECTILE);
          p.play(sprite);
          this.tweens.add({ targets: p, x: tx, y: ty - 10, duration: travel, onComplete: () => { p.destroy(); this.hitAt(target, hit); } });
        } else if (has) {
          const m = this.add.sprite(tx, ty - 10, "attacks", frame).setScale(...scale).setDepth(DEPTH.PROJECTILE);
          m.play(sprite);
          m.once("animationcomplete", () => m.destroy());
          this.hitAt(target, hit);
        } else {
          this.hitAt(target, hit);
        }
      });
    }
    hitAt(target, hit) {
      if (!lib.helpers.displayHit || !target.sprite.visible) return;
      try { lib.helpers.displayHit(this, hit, ...target.xy, false); } catch { /* no hit effect */ }
    }
  };
}
// The game's facing (0 down, counting round to 7) for a move from one cell to another
function sectorOf(from, to) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);  // y up the board
  return ["2", "3", "4", "5", "6", "7", "0", "1"][(Math.round(angle / (Math.PI / 4)) + 8) % 8];
}

window.PacBoard = { engine, runFight, teamEffects, mount, cleanBoard,
  get lastFight() { return S.result?.R ?? null; } };  // (the fight on screen, for checking it)
})();
