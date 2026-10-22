const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { referenceMove, seededRandom } = require('./2048-reference.cjs');
const meta = { target: path.resolve(__dirname, '..') };
const storage = new Map();
const context = { module: { exports: {} }, localStorage: {
  getItem: k => storage.has(k) ? storage.get(k) : null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: k => storage.delete(k),
} };
vm.runInNewContext(fs.readFileSync(path.join(meta.target, 'game.js'), 'utf8'), context);
const game = context.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const checks = [];
const check = (name, run) => {
  try { const detail = run(); checks.push({ name, passed: true, detail }); }
  catch (error) { checks.push({ name, passed: false, error: error.message.slice(0, 1800) }); }
};
check('initial board has exactly two valid tiles and zero score', () => {
  const state = game.initGame(seededRandom());
  assert.equal(state.board.flat().filter(Boolean).length, 2);
  assert.ok(state.board.flat().every(v => [0, 2, 4].includes(v)));
  assert.equal(state.score, 0);
});
check('all four directions agree with independent oracle on 1000 seeded boards', () => {
  const random = seededRandom(12345), values = [0, 0, 2, 2, 4, 8, 16];
  for (let n = 0; n < 1000; n++) {
    const board = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => values[Math.floor(random() * values.length)]));
    for (const direction of ['left', 'right', 'up', 'down']) {
      const actual = game['move' + direction[0].toUpperCase() + direction.slice(1)](board);
      const expected = referenceMove(board, direction);
      assert.deepEqual(plain(actual.board), expected.board, `${direction} board ${n}`);
      assert.equal(actual.scoreIncrease, expected.score, `${direction} score ${n}`);
      assert.equal(actual.moved, expected.moved, `${direction} moved ${n}`);
    }
  }
  return '4000 board/direction comparisons';
});
check('single move never merges a newly merged tile twice', () => {
  const board = [[2, 2, 4, 4], [2, 2, 2, 2], [4, 4, 8, 0], [0, 0, 0, 0]];
  const actual = game.moveLeft(board);
  assert.deepEqual(plain(actual.board), [[4, 8, 0, 0], [4, 4, 0, 0], [8, 8, 0, 0], [0, 0, 0, 0]]);
  assert.equal(actual.scoreIncrease, 28);
});
check('unchanged move does not spawn a tile or consume randomness', () => {
  for (const direction of ['left', 'right', 'up', 'down']) {
    const board = Array.from({ length: 4 }, () => Array(4).fill(0));
    board[direction === 'down' ? 3 : 0][direction === 'right' ? 3 : 0] = 2;
    const state = { board, score: 0, won: false, over: false, keepPlaying: false };
    let calls = 0;
    const moved = game.move(state, direction, () => { calls++; return 0; });
    assert.deepEqual(plain(moved.board), board, `${direction}: illegal tile spawn`);
    assert.equal(calls, 0, `${direction}: randomness consumed for unchanged board`);
  }
});
check('valid merge increments score and spawns exactly one tile', () => {
  const state = { board: [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 10, won: false, over: false, keepPlaying: false };
  const moved = game.move(state, 'left', () => 0);
  assert.equal(moved.score, 14);
  assert.equal(moved.board.flat().filter(Boolean).length, 2);
  assert.equal(moved.board.flat().reduce((a, b) => a + b), 6);
});
check('2048 merge wins and can continue playing', () => {
  const state = { board: [[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 0, won: false, over: false, keepPlaying: false };
  const won = game.move(state, 'left', () => 0);
  assert.equal(won.won, true);
  assert.equal(won.score, 2048);
  const continued = game.move({ ...won, keepPlaying: true }, 'down', () => 0);
  assert.equal(continued.won, true);
  assert.equal(continued.keepPlaying, true);
});
check('game-over detects both empty cells and adjacent merge opportunities', () => {
  const blocked = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
  assert.equal(game.isGameOver(blocked), true);
  assert.equal(game.hasMoves(blocked), false);
  blocked[0][0] = 0;
  assert.equal(game.isGameOver(blocked), false);
  blocked[0][0] = 4;
  assert.equal(game.isGameOver(blocked), false);
});
check('state and best score survive a storage round trip', () => {
  storage.clear();
  const state = game.initGame(() => 0);
  state.score = 40;
  game.saveState(state, 100);
  const restored = game.loadState();
  assert.deepEqual(plain(restored.gameState), plain(state));
  assert.equal(restored.bestScore, 100);
});
check('malformed saved JSON recovers safely', () => {
  storage.set('2048_state', '{broken');
  assert.equal(game.loadState(), null);
});
check('invalid tile values in saved data are rejected', () => {
  const invalid = { board: [[3, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 0, won: false, keepPlaying: false };
  storage.set('2048_state', JSON.stringify(invalid));
  assert.equal(game.loadState(), null);
});
const report = { checkedAt: new Date().toISOString(), target: meta.target, checks, passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length };
fs.writeFileSync(path.join(__dirname, 'independent-checks.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.failed ? 1 : 0;

