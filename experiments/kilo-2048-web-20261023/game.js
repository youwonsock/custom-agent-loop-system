function isPowerOfTwo(n) {
  if (n === 0) return true;
  if (n < 1 || !Number.isInteger(n)) return false;
  return (n & (n - 1)) === 0;
}

function createEmptyBoard() {
  const board = [];
  for (let i = 0; i < 4; i++) {
    board[i] = [];
    for (let j = 0; j < 4; j++) {
      board[i][j] = 0;
    }
  }
  return board;
}

function copyBoard(board) {
  const newBoard = createEmptyBoard();
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      newBoard[i][j] = board[i][j];
    }
  }
  return newBoard;
}

function addRandomTile(board, rng) {
  const emptyCells = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (board[i][j] === 0) {
        emptyCells.push({i, j});
      }
    }
  }
  if (emptyCells.length === 0) return board;
  
  const randomIndex = Math.floor(rng() * emptyCells.length);
  const cell = emptyCells[randomIndex];
  // 90% chance for 2, 10% chance for 4
  board[cell.i][cell.j] = rng() < 0.9 ? 2 : 4;
  return board;
}

function initGame(rng = Math.random) {
  let board = createEmptyBoard();
  board = addRandomTile(board, rng);
  board = addRandomTile(board, rng);
  return {
    board: board,
    score: 0,
    won: false,
    over: false,
    keepPlaying: false
  };
}

function moveLeft(board) {
  const newBoard = createEmptyBoard();
  let scoreIncrease = 0;
  let moved = false;
  
  for (let i = 0; i < 4; i++) {
    const row = [board[i][0], board[i][1], board[i][2], board[i][3]];
    const merged = [false, false, false, false];
    const newRow = [0, 0, 0, 0];
    let writePos = 0;
    
    for (let j = 0; j < 4; j++) {
      if (row[j] === 0) continue;
      
      if (writePos > 0 && newRow[writePos - 1] === row[j] && !merged[writePos - 1]) {
        // Merge
        newRow[writePos - 1] = row[j] * 2;
        merged[writePos - 1] = true;
        scoreIncrease += row[j] * 2;
        moved = true;
      } else {
        if (writePos !== j) {
          moved = true;
        }
        newRow[writePos] = row[j];
        writePos++;
      }
    }
    
    for (let j = 0; j < 4; j++) {
      newBoard[i][j] = newRow[j];
    }
  }
  
  return { board: newBoard, scoreIncrease, moved };
}

function moveRight(board) {
  const newBoard = createEmptyBoard();
  let scoreIncrease = 0;
  let moved = false;
  
  for (let i = 0; i < 4; i++) {
    const row = [board[i][0], board[i][1], board[i][2], board[i][3]];
    const merged = [false, false, false, false];
    const newRow = [0, 0, 0, 0];
    let writePos = 3;
    
    for (let j = 3; j >= 0; j--) {
      if (row[j] === 0) continue;
      
      if (writePos < 3 && newRow[writePos + 1] === row[j] && !merged[writePos + 1]) {
        // Merge
        newRow[writePos + 1] = row[j] * 2;
        merged[writePos + 1] = true;
        scoreIncrease += row[j] * 2;
        moved = true;
      } else {
        if (writePos !== j) {
          moved = true;
        }
        newRow[writePos] = row[j];
        writePos--;
      }
    }
    
    for (let j = 0; j < 4; j++) {
      newBoard[i][j] = newRow[j];
    }
  }
  
  return { board: newBoard, scoreIncrease, moved };
}

function moveUp(board) {
  const newBoard = createEmptyBoard();
  let scoreIncrease = 0;
  let moved = false;
  
  for (let j = 0; j < 4; j++) {
    const column = [board[0][j], board[1][j], board[2][j], board[3][j]];
    const merged = [false, false, false, false];
    const newColumn = [0, 0, 0, 0];
    let writePos = 0;
    
    for (let i = 0; i < 4; i++) {
      if (column[i] === 0) continue;
      
      if (writePos > 0 && newColumn[writePos - 1] === column[i] && !merged[writePos - 1]) {
        // Merge
        newColumn[writePos - 1] = column[i] * 2;
        merged[writePos - 1] = true;
        scoreIncrease += column[i] * 2;
        moved = true;
      } else {
        if (writePos !== i) {
          moved = true;
        }
        newColumn[writePos] = column[i];
        writePos++;
      }
    }
    
    for (let i = 0; i < 4; i++) {
      newBoard[i][j] = newColumn[i];
    }
  }
  
  return { board: newBoard, scoreIncrease, moved };
}

function moveDown(board) {
  const newBoard = createEmptyBoard();
  let scoreIncrease = 0;
  let moved = false;
  
  for (let j = 0; j < 4; j++) {
    const column = [board[0][j], board[1][j], board[2][j], board[3][j]];
    const merged = [false, false, false, false];
    const newColumn = [0, 0, 0, 0];
    let writePos = 3;
    
    for (let i = 3; i >= 0; i--) {
      if (column[i] === 0) continue;
      
      if (writePos < 3 && newColumn[writePos + 1] === column[i] && !merged[writePos + 1]) {
        // Merge
        newColumn[writePos + 1] = column[i] * 2;
        merged[writePos + 1] = true;
        scoreIncrease += column[i] * 2;
        moved = true;
      } else {
        if (writePos !== i) {
          moved = true;
        }
        newColumn[writePos] = column[i];
        writePos--;
      }
    }
    
    for (let i = 0; i < 4; i++) {
      newBoard[i][j] = newColumn[i];
    }
  }
  
  return { board: newBoard, scoreIncrease, moved };
}

function move(gameState, direction, rng = Math.random) {
  let result;
  if (direction === 'left') result = moveLeft(gameState.board);
  else if (direction === 'right') result = moveRight(gameState.board);
  else if (direction === 'up') result = moveUp(gameState.board);
  else if (direction === 'down') result = moveDown(gameState.board);
  else return gameState;
  
  if (!result.moved) {
    return gameState;
  }
  
  let newBoard = copyBoard(result.board);
  newBoard = addRandomTile(newBoard, rng);
  
  const newState = {
    board: newBoard,
    score: gameState.score + result.scoreIncrease,
    won: gameState.won,
    over: gameState.over,
    keepPlaying: gameState.keepPlaying
  };
  
  if (!newState.won && checkWin(newBoard)) {
    newState.won = true;
  }
  
  if (isGameOver(newBoard)) {
    newState.over = true;
  }
  
  return newState;
}

function checkWin(board) {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (board[i][j] === 2048) {
        return true;
      }
    }
  }
  return false;
}

function isGameOver(board) {
  // Check if any empty cells
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (board[i][j] === 0) return false;
    }
  }
  // Check adjacent matches
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const val = board[i][j];
      if (i < 3 && board[i+1][j] === val) return false;
      if (j < 3 && board[i][j+1] === val) return false;
    }
  }
  return true;
}

function hasMoves(board) {
  return !isGameOver(board);
}

function saveState(gameState, bestScore) {
  try {
    const stateToSave = {
      board: gameState.board,
      score: gameState.score,
      won: gameState.won,
      keepPlaying: gameState.keepPlaying
    };
    localStorage.setItem('2048_state', JSON.stringify(stateToSave));
    localStorage.setItem('2048_best', String(bestScore));
  } catch (e) {
    // Ignore save errors
  }
}

function loadState() {
  try {
    const stateStr = localStorage.getItem('2048_state');
    const bestStr = localStorage.getItem('2048_best');
    
    if (!stateStr) return null;
    
    const state = JSON.parse(stateStr);
    const best = bestStr ? parseInt(bestStr) : 0;
    
    // Validate state
    if (!state.board || !Array.isArray(state.board) || state.board.length !== 4) {
      throw new Error('Invalid state');
    }
    for (let i = 0; i < 4; i++) {
      if (!Array.isArray(state.board[i]) || state.board[i].length !== 4) {
        throw new Error('Invalid state');
      }
      for (let j = 0; j < 4; j++) {
        const val = state.board[i][j];
        if (typeof val !== 'number' || val < 0 || !isPowerOfTwo(val)) {
          throw new Error('Invalid state');
        }
      }
    }
    
    return {
      gameState: {
        board: state.board,
        score: typeof state.score === 'number' ? state.score : 0,
        won: !!state.won,
        over: isGameOver(state.board),
        keepPlaying: !!state.keepPlaying
      },
      bestScore: isNaN(best) ? 0 : best
    };
  } catch (e) {
    // On corruption, return null to start fresh
    try {
      localStorage.removeItem('2048_state');
      localStorage.removeItem('2048_best');
    } catch (e2) {}
    return null;
  }
}

// Export for Node tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createEmptyBoard,
    copyBoard,
    addRandomTile,
    initGame,
    moveLeft,
    moveRight,
    moveUp,
    moveDown,
    move,
    checkWin,
    isGameOver,
    hasMoves,
    saveState,
    loadState
  };
}
