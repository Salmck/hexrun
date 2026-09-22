import { Game } from './game.js?v=134';

const canvas = document.getElementById('scene');
const labelAEl = document.getElementById('label-a');
const labelBEl = document.getElementById('label-b');
const statAEl = document.getElementById('stat-a');
const statBEl = document.getElementById('stat-b');
const toggleBtn = document.getElementById('btn-toggle');
const gametypeBtn = document.getElementById('btn-gametype');
const mapStrategyBtn = document.getElementById('btn-map-strategy');
const resetBtn = document.getElementById('btn-reset');
const speedSelect = document.getElementById('speed');
const racerCountSelect = document.getElementById('racer-count');
const racerLabelText = document.getElementById('racer-label-text');
const agent4MapSizeLabel = document.getElementById('agent4-mapsize-label');
const agent4MapSizeInput = document.getElementById('agent4-mapsize');
const agent4SeedLabel = document.getElementById('agent4-seed-label');
const agent4SeedInput = document.getElementById('agent4-seed');
const compareModeLabel = document.getElementById('compare-mode-label');
const compareModeSelect = document.getElementById('compare-mode');
const compareProbLabel = document.getElementById('compare-prob-label');
const compareProbInput = document.getElementById('compare-prob');
const saveMapBtn = document.getElementById('btn-save-map');
const openMapBtn = document.getElementById('btn-open-map');
const openMapFile = document.getElementById('open-map-file');
const controlsBreak = document.getElementById('controls-break');
const colorPanelBtn = document.getElementById('btn-color-panel');
const colorPanel = document.getElementById('agent4-color-panel');
const compareStatsPanel = document.getElementById('compare-stats-panel');
const compareStatDiscover = document.getElementById('compare-stat-discover');
const compareStatFinish = document.getElementById('compare-stat-finish');
const compareStatYields = document.getElementById('compare-stat-yields');
const compareStatStuck = document.getElementById('compare-stat-stuck');
const compareStatSteps = document.getElementById('compare-stat-steps');
const compareStatTicks = document.getElementById('compare-stat-ticks');
const compareStatTickMs = document.getElementById('compare-stat-tickms');

const game = new Game(canvas, {
  onStats: (stats) => {
    if (stats.gameType === 'track') {
      labelAEl.textContent = '比赛进度';
      labelBEl.textContent = '完赛情况';
      statAEl.textContent = `${stats.leaderDistance}/${stats.trackLength}`;
      statBEl.textContent = `${stats.finished}/${stats.racers}`;
    } else {
      labelAEl.textContent = '到达终点';
      labelBEl.textContent = '总步数';
      statAEl.textContent = `${stats.finished}/${stats.racers}`;
      statBEl.textContent = stats.steps;
    }
  },
});
game.setSpeed(speedSelect.value);
window.__game = game;

toggleBtn.addEventListener('click', () => {
  const running = game.toggle();
  toggleBtn.textContent = running ? '暂停' : '继续';
});

// Agent mode 4 and compare mode both start every freshly (re)generated map
// paused (see Game#_setupMapMode) - their settings (task count/map size/
// seed/routing choice) are easy to keep tweaking right up until someone's
// actually ready to watch it run. Anything that can trigger a reset needs
// to re-sync this button afterward, since game.running may have just
// changed out from under it.
const syncToggleButton = () => {
  toggleBtn.textContent = game.running ? '暂停' : '继续';
};

// Both agent mode 4 and compare mode share this whole second row of
// controls (map size, seed, save/open, color panel) - they just read/write
// different underlying Game fields depending on which one is active (see
// applyAgent4MapSize/applyAgent4Seed below). Agent mode 4 additionally
// repurposes the racer-count box into a task-count box (one task = one
// goal line; the session's actual racer count is derived from however many
// goals that many lines end up needing - see Game#agent4TaskCount); compare
// mode keeps it meaning "how many racers", same as every other mode/
// strategy.
const syncRacerControl = () => {
  const isAgent4 = game.gameType === 'map' && game.mapStrategy === 'agent4';
  const isCompare = game.gameType === 'map' && game.mapStrategy === 'compare';
  const usesMapPanel = isAgent4 || isCompare;
  racerLabelText.textContent = isAgent4 ? '任务数量' : '参赛物体';
  racerCountSelect.max = String(isAgent4 ? 4 : game.getMaxRacers());
  racerCountSelect.value = String(isAgent4 ? game.agent4TaskCount : game.racerCount);

  agent4MapSizeLabel.hidden = !usesMapPanel;
  agent4SeedLabel.hidden = !usesMapPanel;
  compareModeLabel.hidden = !isCompare;
  compareProbLabel.hidden = !isCompare;
  saveMapBtn.hidden = !usesMapPanel;
  openMapBtn.hidden = !usesMapPanel;
  controlsBreak.hidden = !usesMapPanel;
  if (isAgent4) {
    agent4MapSizeInput.value = String(game.agent4MapSize);
    agent4SeedInput.value = String(game.agent4Seed);
  } else if (isCompare) {
    agent4MapSizeInput.value = String(game.compareMapSize);
    agent4SeedInput.value = String(game.compareSeed);
    compareModeSelect.value = game.compareMode;
    compareProbInput.value = String(game.compareObstacleProbability);
  }
  syncColorPanel(usesMapPanel);
  compareStatsPanel.hidden = !isCompare;
  if (isCompare) updateCompareStatsPanel();
};

// Live readout of the current compare-mode run's stats (game.compareStats,
// filled in by Game#_tick/_applyMapMove/agent2ChainYield/agent2ForceYield -
// see game.js for exactly where each field comes from). Polled on an
// interval rather than driven off Game#onStats, since these numbers need to
// keep reading correctly (and settle on their final values) whether the
// game is running, paused, or freshly reset - onStats only ever fires while
// actually running. discoveredAt/completedAt are round numbers (tickCount's
// value at that moment), not timestamps - see game.js's _tick, which stops
// advancing tickCount for good once completedAt is set, so 总轮数 itself
// also stops the instant every racer has reached a goal instead of idling
// upward forever.
const updateCompareStatsPanel = () => {
  if (game.mapStrategy !== 'compare') return;
  const s = game.compareStats;
  if (!s) return;
  compareStatDiscover.textContent = s.discoveredAt === null ? '--' : String(s.discoveredAt);
  compareStatFinish.textContent = (s.discoveredAt === null || s.completedAt === null)
    ? '--' : String(s.completedAt - s.discoveredAt);
  compareStatYields.textContent = String(s.yieldCount);
  compareStatStuck.textContent = String(s.stuckRacerIds ? s.stuckRacerIds.length : 0);
  compareStatSteps.textContent = String(game.mapRacers.reduce((sum, r) => sum + r.steps, 0));
  compareStatTicks.textContent = String(s.tickCount);
  compareStatTickMs.textContent = s.tickCount ? `${(s.totalTickMs / s.tickCount).toFixed(3)}ms` : '--';
};
setInterval(updateCompareStatsPanel, 200);

// Rebuilds the color panel to match the CURRENT racer set (one swatch per
// racer, labeled by index only - the palette is keyed by index, not robot
// type) - called from syncRacerControl, so every place that already
// re-syncs the agent-4/compare controls after a mode/strategy switch,
// reset, map load, or task-count/map-size/seed/routing-mode change keeps
// this in step too, with no extra call sites to remember. Leaving both
// modes also closes the panel, so re-entering either one later starts from
// a clean, closed state rather than reopening whatever was left open.
const syncColorPanel = (usesMapPanel) => {
  colorPanelBtn.hidden = !usesMapPanel;
  if (!usesMapPanel) {
    colorPanel.hidden = true;
    colorPanel.textContent = '';
    return;
  }
  colorPanel.textContent = '';
  for (const racer of game.mapRacers) {
    const label = document.createElement('label');
    label.className = 'color-swatch';
    const span = document.createElement('span');
    span.textContent = `#${racer.id}`;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = game.getAgent4RacerColorHex(racer.id);
    input.dataset.racerId = String(racer.id);
    label.append(span, input);
    colorPanel.appendChild(label);
  }
};

colorPanelBtn.addEventListener('click', () => {
  colorPanel.hidden = !colorPanel.hidden;
});

colorPanel.addEventListener('input', (e) => {
  const input = e.target;
  if (input.tagName !== 'INPUT' || input.type !== 'color') return;
  game.setAgent4RacerColor(Number(input.dataset.racerId), input.value);
});

syncRacerControl();

gametypeBtn.addEventListener('click', () => {
  const type = game.switchGameType(game.gameType === 'track' ? 'map' : 'track');
  gametypeBtn.textContent = type === 'track' ? '赛道模式' : '地图模式';
  mapStrategyBtn.hidden = type !== 'map';
  syncRacerControl();
  syncToggleButton();
});

const MAP_STRATEGY_LABEL = { path: 'A* 寻路', explore: '自主探索', agent: '智能体模式', agent2: '智能体模式2', agent3: '智能体模式3', agent4: '智能体模式4', compare: '对比试验' };
mapStrategyBtn.addEventListener('click', () => {
  const strategy = game.toggleMapStrategy();
  mapStrategyBtn.textContent = MAP_STRATEGY_LABEL[strategy];
  syncRacerControl();
  syncToggleButton();
});

resetBtn.addEventListener('click', () => {
  game.reset();
  // Every other mode always resumes right after a manual reset; agent mode
  // 4 and compare mode instead respect whatever game.reset() just decided
  // (always paused - see Game#_setupMapMode), so pressing 重置 there
  // doesn't fight the "review the new map before starting it" behavior
  // those settings exist for.
  const usesMapPanel = game.gameType === 'map' && (game.mapStrategy === 'agent4' || game.mapStrategy === 'compare');
  if (!usesMapPanel && !game.running) game.toggle();
  syncColorPanel(usesMapPanel); // a reset can reroll a random seed into a different racer count
  syncToggleButton();
});

speedSelect.addEventListener('change', () => {
  game.setSpeed(speedSelect.value);
});

const applyRacerCount = () => {
  if (racerCountSelect.value === '') return;
  const isAgent4 = game.gameType === 'map' && game.mapStrategy === 'agent4';
  const isCompare = game.gameType === 'map' && game.mapStrategy === 'compare';
  const count = isAgent4
    ? game.setAgent4TaskCount(Number(racerCountSelect.value))
    : game.setRacerCount(Number(racerCountSelect.value));
  racerCountSelect.value = String(count);
  syncColorPanel(isAgent4 || isCompare); // racer count/set just changed - the panel's rows need to match
  syncToggleButton();
};
racerCountSelect.addEventListener('input', applyRacerCount);
racerCountSelect.addEventListener('change', applyRacerCount);

// Map size and seed only take effect on 'change' (blur or Enter), not
// every keystroke ('input') - unlike the small 1-4 task-count box, these
// can be several digits long (a seed especially), and regenerating the
// whole map after every single character typed would mean whatever's on
// screen when you stop to look almost never matches the value actually
// sitting in the box. Both agent mode 4 and compare mode share this same
// pair of inputs - which underlying setter gets called depends on which
// one is currently active.
const applyAgent4MapSize = () => {
  if (agent4MapSizeInput.value === '') return;
  const isCompare = game.mapStrategy === 'compare';
  const size = isCompare
    ? game.setCompareMapSize(Number(agent4MapSizeInput.value))
    : game.setAgent4MapSize(Number(agent4MapSizeInput.value));
  agent4MapSizeInput.value = String(size);
  syncColorPanel(true); // regenerated the map - racer count may have changed
  syncToggleButton();
};
agent4MapSizeInput.addEventListener('change', applyAgent4MapSize);

const applyAgent4Seed = () => {
  if (agent4SeedInput.value === '') return;
  const isCompare = game.mapStrategy === 'compare';
  const seed = isCompare
    ? game.setCompareSeed(Number(agent4SeedInput.value))
    : game.setAgent4Seed(Number(agent4SeedInput.value));
  agent4SeedInput.value = String(seed);
  syncColorPanel(true); // regenerated the map - racer count may have changed
  syncToggleButton();
};
agent4SeedInput.addEventListener('change', applyAgent4Seed);

compareModeSelect.addEventListener('change', () => {
  compareModeSelect.value = game.setCompareMode(compareModeSelect.value);
  syncColorPanel(true); // regenerated the map - racer count may have changed
  syncToggleButton();
});

// Same 'change'-only timing as map size/seed above, for the same reason.
const applyCompareObstacleProb = () => {
  if (compareProbInput.value === '') return;
  const prob = game.setCompareObstacleProbability(Number(compareProbInput.value));
  compareProbInput.value = String(prob);
  syncColorPanel(true); // regenerated the map - racer count may have changed
  syncToggleButton();
};
compareProbInput.addEventListener('change', applyCompareObstacleProb);

saveMapBtn.addEventListener('click', () => {
  game.saveMapConfig();
});

openMapBtn.addEventListener('click', () => {
  openMapFile.value = '';
  openMapFile.click();
});

openMapFile.addEventListener('change', async () => {
  const file = openMapFile.files && openMapFile.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    game.loadMapConfig(text);
    gametypeBtn.textContent = game.gameType === 'track' ? '赛道模式' : '地图模式';
    mapStrategyBtn.hidden = game.gameType !== 'map';
    mapStrategyBtn.textContent = MAP_STRATEGY_LABEL[game.mapStrategy];
    syncRacerControl();
    syncToggleButton(); // loadMapConfig leaves the game paused - see Game#_setupMapMode
  } catch (err) {
    console.error('Failed to load map file:', err);
    window.alert('地图文件读取失败：' + err.message);
  }
});
