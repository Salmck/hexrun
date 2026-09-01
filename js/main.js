import { Game } from './game.js?v=111';

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
