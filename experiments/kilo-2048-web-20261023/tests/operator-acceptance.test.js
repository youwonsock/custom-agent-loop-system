// Independent operator acceptance tests. These verify behavior, not model claims.
(async () => {
  const { default: test } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const vm = await import('node:vm');
  const root = process.cwd();
  const plain = x => JSON.parse(JSON.stringify(x));
  function fixture(withApp = false) {
    const saved = new Map();
    const nodes = new Map();
    const listeners = new Map();
    function element() {
      const classes = new Set();
      const events = new Map();
      return {
        children: [], style: {}, textContent: '', onclick: null,
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
        appendChild(child) { this.children.push(child); return child; },
        getBoundingClientRect: () => ({ width: 400, height: 400, top: 0, left: 0 }),
        set innerHTML(value) { this.children = []; },
        get innerHTML() { return ''; },
        addEventListener(type, fn) { if (!events.has(type)) events.set(type, []); events.get(type).push(fn); },
        dispatchEvent(event) {
          if (event.type === 'click' && typeof this.onclick === 'function') this.onclick(event);
          for (const fn of events.get(event.type) || []) fn(event);
        },
      };
    }
    for (const match of fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) nodes.set(match[1], element());
    const context = vm.createContext({
      module: { exports: {} }, console,
      localStorage: { getItem: k => saved.has(k) ? saved.get(k) : null, setItem: (k, v) => saved.set(k, String(v)), removeItem: k => saved.delete(k) },
      document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element },
      window: { addEventListener: (type, fn) => listeners.set(type, fn), getComputedStyle: () => ({ gap: '10px' }) },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'game.js'), 'utf8'), context);
    const game = context.module.exports;
    if (withApp) vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
    return { context, game, saved, nodes, listeners };
  }
  test('operator: blocked moves never create a tile or consume RNG in all four directions', () => {
    const { game } = fixture();
    for (const direction of ['left', 'right', 'up', 'down']) {
      const board = Array.from({ length: 4 }, () => Array(4).fill(0));
      board[direction === 'down' ? 3 : 0][direction === 'right' ? 3 : 0] = 2;
      let calls = 0;
      const result = game.move({ board, score: 0, won: false, over: false, keepPlaying: false }, direction, () => { calls++; return 0; });
      assert.deepEqual(plain(result.board), board, direction + ' created a tile on an unchanged board');
      assert.equal(calls, 0, direction + ' used RNG for an unchanged move');
    }
  });
  test('operator: corrupted saved boards reject tiles that are not powers of two', () => {
    const { game, saved } = fixture();
    for (const invalid of [3, 1.5, -2]) {
      const board = Array.from({ length: 4 }, () => Array(4).fill(0));
      board[0][0] = invalid;
      saved.set('2048_state', JSON.stringify({ board, score: 0, won: false, keepPlaying: false }));
      assert.equal(game.loadState(), null, 'invalid tile ' + invalid + ' must recover as a fresh game');
    }
  });
  test('operator: New Game button works on the first visit with empty storage', () => {
    const { context, nodes, listeners } = fixture(true);
    listeners.get('load')();
    const button = nodes.get('new-game');
    vm.runInContext('gameState.score = 99; renderBoard();', context);
    button.dispatchEvent({ type: 'click' });
    assert.equal(String(nodes.get('score').textContent), '0');
    assert.equal(nodes.get('tile-container').children.length, 2);
  });
  test('operator: reaching game over after Keep playing still shows restart controls', () => {
    const { context, nodes } = fixture(true);
    vm.runInContext('gameState = { board: [[4096,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]], score: 4096, won: true, over: true, keepPlaying: true }; renderBoard();', context);
    const overlay = nodes.get('message-layer');
    assert.equal(overlay.classList.contains('show'), true, 'Game over was hidden after Keep playing');
    assert.ok(overlay.children.some(child => /game over/i.test(child.textContent)));
    assert.ok(overlay.children.some(child => child.children.some(button => /try again|new game|restart/i.test(button.textContent))));
  });
  test('operator: game over restart resets state and clears overlay', () => {
    const { context, nodes } = fixture(true);
    vm.runInContext('gameState = { board: [[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]], score: 100, won: false, over: true, keepPlaying: false }; renderBoard();', context);
    const overlay = nodes.get('message-layer');
    const actions = overlay.children[1];
    actions.children[0].onclick();
    assert.equal(String(nodes.get('score').textContent), '0');
    assert.equal(nodes.get('tile-container').children.length, 2);
    assert.equal(overlay.classList.contains('show'), false);
  });
  test('operator: arrows and four swipe directions prevent scrolling and ignore short gestures', () => {
    const events = new Map();
    const moves = [];
    let prevented = 0;
    const context = vm.createContext({
      document: { addEventListener: (type, fn, options) => events.set(type, { fn, options }) },
      handleMove: direction => moves.push(direction),
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'input.js'), 'utf8'), context);
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a']) {
      events.get('keydown').fn({ key, preventDefault() { prevented++; } });
    }
    assert.deepEqual(moves, ['left', 'right', 'up', 'down']);
    assert.equal(prevented, 4);
    assert.equal(events.get('touchmove').options.passive, false);
    for (const [dx, dy] of [[-80, 5], [80, 5], [5, -80], [5, 80], [10, 10]]) {
      events.get('touchstart').fn({ touches: [{ clientX: 100, clientY: 100 }] });
      events.get('touchmove').fn({ preventDefault() { prevented++; } });
      events.get('touchend').fn({ changedTouches: [{ clientX: 100 + dx, clientY: 100 + dy }] });
    }
    assert.deepEqual(moves.slice(4), ['left', 'right', 'up', 'down']);
    assert.equal(prevented, 9);
    events.get('touchmove').fn({ preventDefault() { assert.fail('idle touchmove prevented scrolling'); } });
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
