// Comparison-experiment mode ("对比试验") - decoupled the same way agent2/3/4
// are: game.js keeps only the thin dispatch hooks, all the actual logic lives
// here.
//
// The map is generated exactly like agent2's (a scattered goal cluster, one
// goal per racer, on a plain generated obstacle field) - see
// Game#_setupMapMode, which calls generateObstacleGrid/pickScatteredGoals
// with this mode's own map size and seeded RNG (game.compareRng) instead of
// agent2's fixed size and Math.random, so a run here is reproducible the
// same way agent4's is.
//
// What's actually being compared is routing LOGIC: game.compareMode selects
// one of four "logics" (a/b/c/d, picked in the panel) that every racer in the
// session uses.
//
// - B, C, D all delegate to agent2's own routing verbatim, unchanged (fully
//   shared field of view from the very first tick) - D exists specifically
//   as that untouched baseline to compare mode A against; B/C are still the
//   same placeholder seam as D until they get their own distinct logic.
// - A withholds the shared field of view: each racer only "knows" what it
//   personally has sensed, so goal-discovery doesn't instantly propagate to
//   the whole swarm. The moment any racer actually reaches (settles on) a
//   goal, every racer's private view is folded into one shared pool and
//   vision behaves exactly like B/C/D from then on.
import { agent2SetupState, agent2ChooseMove, agent2Sense } from './agent2.js?v=88';

export function compareSetupState(game, starts) {
  agent2SetupState(game, starts);
  // Only meaningful for mode A (see compareChooseMove) - harmlessly unused
  // by B/C/D, which always pass agent2ChooseMove its default (game.agent2Sensed).
  game.compareVisionShared = false;
}

// Mode A's private-vision phase ends the instant any racer has actually
// reached a goal. At that moment, fold every racer's own private sensed
// cells into the one shared pool (game.agent2Sensed) so nothing anyone
// already found on their own has to be rediscovered from scratch.
function compareAUnlockSharedVision(game) {
  if (game.compareVisionShared) return;
  if (!game.mapRacers.some((r) => r.status === 'reached')) return;
  game.compareVisionShared = true;
  for (const r of game.mapRacers) {
    if (!r.comparePrivateSensed) continue;
    for (const key of r.comparePrivateSensed) game.agent2Sensed.add(key);
  }
}

// Game#_applyMapMove senses from a racer's newly-arrived cell right after
// moving it there (separately from the sensing agent2ChooseMove already does
// at decision time) - that call needs the same private-until-unlock routing
// as compareChooseMove, or a racer arriving on a cell (rather than merely
// deciding to head there) would leak straight into the shared pool even
// during mode A's private phase.
export function compareSense(game, racer) {
  if (game.compareMode !== 'a' || game.compareVisionShared) {
    agent2Sense(game, racer);
    return;
  }
  racer.comparePrivateSensed = racer.comparePrivateSensed || new Set();
  agent2Sense(game, racer, racer.comparePrivateSensed);
}

// Whether any racer - via the shared pool, or (mode A, pre-unlock) its own
// private view - has ever sensed at least one of the map's goal cells. Used
// for the "发现目标轮数" stat, which should reflect the first time ANYONE
// became aware of a goal, not just the first time that awareness was shared.
export function compareAnyGoalSensed(game) {
  if (game.mapGoals.some((g) => game.agent2Sensed.has(`${g.bx},${g.by}`))) return true;
  return game.mapRacers.some((r) => r.comparePrivateSensed &&
    game.mapGoals.some((g) => r.comparePrivateSensed.has(`${g.bx},${g.by}`)));
}

export function compareChooseMove(game, racer) {
  switch (game.compareMode) {
    case 'a': {
      compareAUnlockSharedVision(game);
      if (game.compareVisionShared) return agent2ChooseMove(game, racer);
      racer.comparePrivateSensed = racer.comparePrivateSensed || new Set();
      return agent2ChooseMove(game, racer, racer.comparePrivateSensed);
    }
    case 'b': return agent2ChooseMove(game, racer);
    case 'c': return agent2ChooseMove(game, racer);
    case 'd':
    default: return agent2ChooseMove(game, racer);
  }
}
