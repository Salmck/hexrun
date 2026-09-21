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
// one of three interchangeable "logics" (a/b/c, picked in the panel) that
// every racer in the session uses. All three currently delegate to agent2's
// own routing verbatim, unchanged - this module is only the seam where each
// one will eventually get its own distinct implementation to compare against
// the others on identical maps.
import { agent2SetupState, agent2ChooseMove } from './agent2.js?v=87';

export function compareSetupState(game, starts) {
  agent2SetupState(game, starts);
}

export function compareChooseMove(game, racer) {
  switch (game.compareMode) {
    case 'b': return agent2ChooseMove(game, racer);
    case 'c': return agent2ChooseMove(game, racer);
    case 'a':
    default: return agent2ChooseMove(game, racer);
  }
}
