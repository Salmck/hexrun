import { Game } from './game.js';

const canvas = document.getElementById('scene');
const labelAEl = document.getElementById('label-a');
const labelBEl = document.getElementById('label-b');
const statAEl = document.getElementById('stat-a');
const statBEl = document.getElementById('stat-b');
const toggleBtn = document.getElementById('btn-toggle');
const gametypeBtn = document.getElementById('btn-gametype');
const modeBtn = document.getElementById('btn-mode');
const resetBtn = document.getElementById('btn-reset');
const speedSelect = document.getElementById('speed');

const MAP_STATUS_TEXT = {
  solving: '寻路中',
  reached: '已到达!',
  stuck: '无法到达',
};

const game = new Game(canvas, {
  onStats: (stats) => {
    if (stats.gameType === 'track') {
      labelAEl.textContent = '前进格数';
      labelBEl.textContent = '躲避次数';
      statAEl.textContent = stats.distance;
      statBEl.textContent = stats.dodges;
    } else {
      labelAEl.textContent = '已走步数';
      labelBEl.textContent = '状态';
      statAEl.textContent = stats.steps;
      statBEl.textContent =
        stats.status === 'solving' && stats.mode === 'manual'
          ? '手动驾驶'
          : MAP_STATUS_TEXT[stats.status];
    }
  },
});
game.setSpeed(speedSelect.value);
window.__game = game;

toggleBtn.addEventListener('click', () => {
  const running = game.toggle();
  toggleBtn.textContent = running ? '暂停' : '继续';
});

gametypeBtn.addEventListener('click', () => {
  const type = game.switchGameType(game.gameType === 'track' ? 'map' : 'track');
  gametypeBtn.textContent = type === 'track' ? '赛道模式' : '地图模式';
});

modeBtn.addEventListener('click', () => {
  const mode = game.toggleMode();
  modeBtn.textContent = mode === 'auto' ? '模式：自动' : '模式：手动';
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
