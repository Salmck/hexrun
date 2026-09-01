import { Game } from './game.js?v=114';

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
const saveMapBtn = document.getElementById('btn-save-map');
const openMapBtn = document.getElementById('btn-open-map');
const openMapFile = document.getElementById('open-map-file');

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

// Agent mode 4 repurposes the racer-count box into a task-count box (one
// task = one goal line; the session's actual racer count is derived from
// however many goals that many lines end up needing - see
// Game#agent4TaskCount). Every other mode/strategy keeps the box meaning
// "how many racers", as before.
const syncRacerControl = () => {
  const isAgent4 = game.gameType === 'map' && game.mapStrategy === 'agent4';
  racerLabelText.textContent = isAgent4 ? '任务数量' : '参赛物体';
  racerCountSelect.max = String(isAgent4 ? 4 : game.getMaxRacers());
  racerCountSelect.value = String(isAgent4 ? game.agent4TaskCount : game.racerCount);

  agent4MapSizeLabel.hidden = !isAgent4;
  agent4SeedLabel.hidden = !isAgent4;
  saveMapBtn.hidden = !isAgent4;
  openMapBtn.hidden = !isAgent4;
  if (isAgent4) {
    agent4MapSizeInput.value = String(game.agent4MapSize);
    agent4SeedInput.value = String(game.agent4Seed);
  }
};
syncRacerControl();

gametypeBtn.addEventListener('click', () => {
  const type = game.switchGameType(game.gameType === 'track' ? 'map' : 'track');
  gametypeBtn.textContent = type === 'track' ? '赛道模式' : '地图模式';
  mapStrategyBtn.hidden = type !== 'map';
  syncRacerControl();
});

const MAP_STRATEGY_LABEL = { path: 'A* 寻路', explore: '自主探索', agent: '智能体模式', agent2: '智能体模式2', agent3: '智能体模式3', agent4: '智能体模式4' };
mapStrategyBtn.addEventListener('click', () => {
  const strategy = game.toggleMapStrategy();
  mapStrategyBtn.textContent = MAP_STRATEGY_LABEL[strategy];
  syncRacerControl();
});

resetBtn.addEventListener('click', () => {
  game.reset();
  if (!game.running) {
    game.toggle();
    toggleBtn.textContent = '暂停';
  }
});

speedSelect.addEventListener('change', () => {
  game.setSpeed(speedSelect.value);
});

const applyRacerCount = () => {
  if (racerCountSelect.value === '') return;
  const isAgent4 = game.gameType === 'map' && game.mapStrategy === 'agent4';
  const count = isAgent4
    ? game.setAgent4TaskCount(Number(racerCountSelect.value))
    : game.setRacerCount(Number(racerCountSelect.value));
  racerCountSelect.value = String(count);
};
racerCountSelect.addEventListener('input', applyRacerCount);
racerCountSelect.addEventListener('change', applyRacerCount);

const applyAgent4MapSize = () => {
  if (agent4MapSizeInput.value === '') return;
  const size = game.setAgent4MapSize(Number(agent4MapSizeInput.value));
  agent4MapSizeInput.value = String(size);
};
agent4MapSizeInput.addEventListener('input', applyAgent4MapSize);
agent4MapSizeInput.addEventListener('change', applyAgent4MapSize);

const applyAgent4Seed = () => {
  if (agent4SeedInput.value === '') return;
  const seed = game.setAgent4Seed(Number(agent4SeedInput.value));
  agent4SeedInput.value = String(seed);
};
agent4SeedInput.addEventListener('input', applyAgent4Seed);
agent4SeedInput.addEventListener('change', applyAgent4Seed);

saveMapBtn.addEventListener('click', () => {
  game.saveAgent4Map();
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
    game.loadAgent4MapConfig(text);
    gametypeBtn.textContent = game.gameType === 'track' ? '赛道模式' : '地图模式';
    mapStrategyBtn.hidden = game.gameType !== 'map';
    mapStrategyBtn.textContent = MAP_STRATEGY_LABEL[game.mapStrategy];
    syncRacerControl();
    if (!game.running) {
      game.toggle();
      toggleBtn.textContent = '暂停';
    }
  } catch (err) {
    console.error('Failed to load agent-4 map file:', err);
    window.alert('地图文件读取失败：' + err.message);
  }
});
