const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmptyBoard, initGame, move, moveLeft, moveRight, moveUp, moveDown, checkWin, isGameOver, addRandomTile, copyBoard } = require('../game.js');

test('merge left basic', () => {
  const board = [[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  const r = moveLeft(board);
  assert.deepEqual(r.board, [[4,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  assert.equal(r.scoreIncrease, 4);
  assert.equal(r.moved, true);
});

test('merge once per tile', () => {
  const board = [[2,2,2,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  const r = moveLeft(board);
  assert.deepEqual(r.board, [[4,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
});

test('all directions', () => {
  const board = [[2,0,0,0],[2,0,0,0],[0,0,0,0],[0,0,0,0]];
  assert.deepEqual(moveUp(board).board, [[4,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  const b2 = [[0,0,0,2],[0,0,0,2],[0,0,0,0],[0,0,0,0]];
  assert.deepEqual(moveRight(b2).board, [[0,0,0,2],[0,0,0,2],[0,0,0,0],[0,0,0,0]]);
  const b3 = [[0,0,0,0],[0,0,0,0],[2,0,0,0],[2,0,0,0]];
  assert.deepEqual(moveDown(b3).board, [[0,0,0,0],[0,0,0,0],[0,0,0,0],[4,0,0,0]]);
});

test('no move when blocked', () => {
  const board = [[2,4,8,16],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  const r = moveLeft(board);
  assert.equal(r.moved, false);
});

test('win detection', () => {
  const board = createEmptyBoard();
  board[0][0] = 2048;
  assert.equal(checkWin(board), true);
  board[0][0] = 1024;
  assert.equal(checkWin(board), false);
});

test('game over detection', () => {
  const board = [[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]];
  assert.equal(isGameOver(board), true);
  const board2 = [[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,0]];
  assert.equal(isGameOver(board2), false);
});

test('init game has two tiles', () => {
  const g = initGame(() => 0.5);
  let count = 0;
  for (let i=0;i<4;i++) for (let j=0;j<4;j++) if (g.board[i][j]!==0) count++;
  assert.equal(count, 2);
});

test('move only spawns on valid move', () => {
  const state = { board: [[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], score:0, won:false, over:false, keepPlaying:false };
  const rng = () => 0.5;
  const ns = move(state, 'left', rng);
  let count=0; for(let i=0;i<4;i++) for(let j=0;j<4;j++) if(ns.board[i][j]!==0) count++;
  assert.equal(count, 2); // merged 4 + one new
});

test('spawned tile value follows 2/4 RNG rule', () => {
  const nearlyFull = [
    [2, 2, 2, 2],
    [2, 2, 2, 2],
    [2, 2, 2, 2],
    [2, 2, 2, 0]
  ];
  const low = addRandomTile(copyBoard(nearlyFull), () => 0);
  assert.equal(low[3][3], 2);
  const high = addRandomTile(copyBoard(nearlyFull), () => 0.95);
  assert.equal(high[3][3], 4);
});
