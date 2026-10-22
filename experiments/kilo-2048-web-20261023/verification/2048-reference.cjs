// Independent acceptance oracle derived from the 2048 rules, not the generated code.
function referenceMove(board, direction) {
  const result = Array.from({ length: 4 }, () => Array(4).fill(0));
  let score = 0;
  for (let line = 0; line < 4; line++) {
    const positions = Array.from({ length: 4 }, (_, n) => {
      if (direction === 'left') return [line, n];
      if (direction === 'right') return [line, 3 - n];
      if (direction === 'up') return [n, line];
      if (direction === 'down') return [3 - n, line];
      throw new Error('Unknown direction');
    });
    const numbers = positions.map(([r, c]) => board[r][c]).filter(Boolean);
    const output = [];
    for (let i = 0; i < numbers.length; i++) {
      if (numbers[i] === numbers[i + 1]) {
        output.push(numbers[i] * 2);
        score += numbers[i] * 2;
        i++;
      } else output.push(numbers[i]);
    }
    positions.forEach(([r, c], n) => { result[r][c] = output[n] || 0; });
  }
  return { board: result, score, moved: JSON.stringify(board) !== JSON.stringify(result) };
}
function seededRandom(seed = 2048) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}
module.exports = { referenceMove, seededRandom };
