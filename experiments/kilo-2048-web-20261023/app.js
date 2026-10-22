let gameState = null;
let bestScore = 0;
let tileIdCounter = 0;

function getTilePosition(row, col) {
  const container = document.getElementById('tile-container');
  const containerRect = container.getBoundingClientRect();
  const containerStyle = window.getComputedStyle(container);
  const gap = parseFloat(containerStyle.gap) || 10;
  const cellSize = (containerRect.width - gap * 3) / 4;
  
  const x = col * (cellSize + gap);
  const y = row * (cellSize + gap);
  return { x, y, size: cellSize };
}

function renderBoard() {
  const container = document.getElementById('tile-container');
  container.innerHTML = '';
  
  if (!gameState) return;
  
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const value = gameState.board[i][j];
      if (value === 0) continue;
      
      const tile = document.createElement('div');
      tile.className = `tile tile-${value}`;
      if (value > 2048) {
        tile.className = 'tile tile-super';
      }
      
      const pos = getTilePosition(i, j);
      tile.style.left = pos.x + 'px';
      tile.style.top = pos.y + 'px';
      tile.style.width = pos.size + 'px';
      tile.style.height = pos.size + 'px';
      tile.textContent = value;
      
      container.appendChild(tile);
    }
  }
  
  document.getElementById('score').textContent = gameState.score;
  document.getElementById('best').textContent = bestScore;
  
  // Show message if game over or won
  const messageLayer = document.getElementById('message-layer');
  messageLayer.innerHTML = '';
  
  if (gameState.over) {
    messageLayer.classList.add('show');
    const msg = document.createElement('div');
    msg.className = 'message';
    msg.textContent = 'Game Over!';
    messageLayer.appendChild(msg);
    
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const tryAgainBtn = document.createElement('button');
    tryAgainBtn.className = 'message-btn';
    tryAgainBtn.textContent = 'Try again';
    tryAgainBtn.onclick = () => {
      startNewGame();
    };
    actions.appendChild(tryAgainBtn);
    messageLayer.appendChild(actions);
  } else if (gameState.won && !gameState.keepPlaying) {
    messageLayer.classList.add('show');
    const msg = document.createElement('div');
    msg.className = 'message';
    msg.textContent = 'You Win!';
    messageLayer.appendChild(msg);
    
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const keepPlayingBtn = document.createElement('button');
    keepPlayingBtn.className = 'message-btn';
    keepPlayingBtn.textContent = 'Keep playing';
    keepPlayingBtn.onclick = () => {
      gameState.keepPlaying = true;
      messageLayer.classList.remove('show');
      if (typeof saveState === 'function') {
        saveState(gameState, bestScore);
      }
    };
    const tryAgainBtn = document.createElement('button');
    tryAgainBtn.className = 'message-btn';
    tryAgainBtn.textContent = 'New Game';
    tryAgainBtn.onclick = () => {
      startNewGame();
    };
    actions.appendChild(keepPlayingBtn);
    actions.appendChild(tryAgainBtn);
    messageLayer.appendChild(actions);
  } else {
    messageLayer.classList.remove('show');
  }
  
  if (typeof saveState === 'function') {
    saveState(gameState, bestScore);
  }
}

function startNewGame() {
  if (typeof initGame === 'function') {
    gameState = initGame();
  } else {
    // Fallback
    gameState = {
      board: [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],
      score: 0,
      won: false,
      over: false,
      keepPlaying: false
    };
    // Add two tiles
    function addTile() {
      const empty = [];
      for (let i=0;i<4;i++) for (let j=0;j<4;j++) if (gameState.board[i][j]===0) empty.push({i,j});
      if (empty.length===0) return;
      const cell = empty[Math.floor(Math.random()*empty.length)];
      gameState.board[cell.i][cell.j] = Math.random()<0.9?2:4;
    }
    addTile(); addTile();
  }
  
  document.getElementById('message-layer').classList.remove('show');
  renderBoard();
}

function handleMove(direction) {
  if (!gameState) return;
  if (gameState.over && !(gameState.won && gameState.keepPlaying)) return;
  if (gameState.won && !gameState.keepPlaying) return;
  
  if (typeof move === 'function') {
    const newState = move(gameState, direction);
    if (newState === gameState) {
      // No move occurred
      return;
    }
    
    gameState = newState;
    if (gameState.score > bestScore) {
      bestScore = gameState.score;
    }
    renderBoard();
  }
}

// Load state on startup
function initApp() {
  // Bind new game button
  const newGameBtn = document.getElementById('new-game');
  if (newGameBtn) {
    newGameBtn.onclick = startNewGame;
  }
  
  if (typeof loadState === 'function') {
    const loaded = loadState();
    if (loaded) {
      gameState = loaded.gameState;
      bestScore = loaded.bestScore;
    } else {
      startNewGame();
      return;
    }
  } else {
    startNewGame();
    return;
  }
  
  renderBoard();
}

window.addEventListener('load', initApp);
