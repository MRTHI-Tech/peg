const assert = require('node:assert/strict');
const test = require('node:test');

const {findOpenNodePosition} = require('../lib/canvas-geometry.ts');

const size = {width: 240, height: 156};
const visibleBounds = {minX: 0, minY: 0, maxX: 900, maxY: 600};

test('the first node keeps the preferred centered position', () => {
  const position = findOpenNodePosition({
    desired: {x: 330, y: 222},
    size,
    occupied: [],
    visibleBounds,
  });

  assert.deepEqual(position, {x: 330, y: 222});
});

test('a later node uses the nearest visible open position', () => {
  const first = {x: 330, y: 222, ...size};
  const position = findOpenNodePosition({
    desired: {x: first.x, y: first.y},
    size,
    occupied: [first],
    visibleBounds,
  });

  assert.deepEqual(position, {x: 594, y: 222});
});

test('successive nodes do not overlap earlier placements', () => {
  const occupied = [{x: 330, y: 222, ...size}];

  for (let index = 0; index < 4; index += 1) {
    const position = findOpenNodePosition({
      desired: {x: 330, y: 222},
      size,
      occupied,
      visibleBounds,
    });
    const next = {...position, ...size};
    assert.ok(
      occupied.every(
        existing =>
          next.x + next.width <= existing.x ||
          existing.x + existing.width <= next.x ||
          next.y + next.height <= existing.y ||
          existing.y + existing.height <= next.y,
      ),
    );
    occupied.push(next);
  }
});
