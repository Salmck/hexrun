import { Game } from './game.js';

const canvas = document.getElementById('scene');
const distanceEl = document.getElementById('stat-distance');
const dodgesEl = document.getElementById('stat-dodges');
const toggleBtn = document.getElementById('btn-toggle');
const modeBtn = document.getElementById('btn-mode');
const resetBtn = document.getElementById('btn-reset');
const speedSelect = document.getElementById('speed');

const game = new Game(canvas, {
  onStats: ({ distance, dodges }) => {
    distanceEl.textContent = distance;
    dodgesEl.textContent = dodges;
  },
});
game.setSpeed(speedSelect.value);
window.__game = game;

toggleBtn.addEventListener('click', () => {
  const running = game.toggle();
  toggleBtn.textContent = running ? '暂停' : '继续';
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
