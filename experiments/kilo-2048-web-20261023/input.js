(function() {
  let touchStartX = 0, touchStartY = 0, touching = false;
  const threshold = 30;

  function getDirection(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0 ? 'right' : 'left';
    }
    return dy > 0 ? 'down' : 'up';
  }

  document.addEventListener('keydown', (e) => {
    let dir = null;
    if (e.key === 'ArrowLeft') dir = 'left';
    else if (e.key === 'ArrowRight') dir = 'right';
    else if (e.key === 'ArrowUp') dir = 'up';
    else if (e.key === 'ArrowDown') dir = 'down';
    if (dir) {
      e.preventDefault();
      if (typeof handleMove === 'function') handleMove(dir);
    }
  });

  document.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length === 0) return;
    touching = true;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (touching) e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (!touching) return;
    touching = false;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
    const dir = getDirection(dx, dy);
    if (typeof handleMove === 'function') handleMove(dir);
  }, { passive: true });
})();