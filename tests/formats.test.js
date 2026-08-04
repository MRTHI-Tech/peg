const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_OUTPAINT_PRESET,
  FORMAT_SELECTOR_OPTIONS,
  presetSize,
  safeAreaForTarget,
  toOutpaintFormat,
  toRunFormat,
} = require('../lib/formats.ts');

test('output choices are grouped into exact sizes and familiar formats', () => {
  assert.deepEqual(
    FORMAT_SELECTOR_OPTIONS.map(section => section.title),
    ['Exact sizes', 'Popular formats', 'App Store'],
  );
  assert.ok(
    FORMAT_SELECTOR_OPTIONS[1].options.some(
      option => option.label === 'X (Twitter) header' && option.description === '1500 × 500',
    ),
  );
});

test('the current primary iPhone App Store preset resolves exactly', () => {
  assert.deepEqual(toRunFormat({preset: 'app-store-iphone-6-9'}), {
    width: 1320,
    height: 2868,
    focal_point: 'right',
    safe_area: 'left-third',
  });
});

test('a descriptive format resolves to its exact output dimensions', () => {
  assert.deepEqual(toRunFormat({preset: 'instagram-story'}), {
    width: 1080,
    height: 1920,
    focal_point: 'right',
    safe_area: 'left-third',
  });
});

test('legacy breakpoint labels still resolve for older graphs', () => {
  assert.equal(toRunFormat({preset: 'Laptop hero'}).width, 1440);
});

test('Extend Canvas resolves the target chosen on the node itself', () => {
  assert.deepEqual(
    toOutpaintFormat({outputSize: '1080x1920', safeArea: 'Upper third', focalPoint: 'Center'}),
    {width: 1080, height: 1920, focal_point: 'center', safe_area: 'upper-third'},
  );
});

test('an Extend Canvas node saved before it had a size falls back to the wide default', () => {
  const fallback = toOutpaintFormat({strength: 0.65});
  assert.deepEqual(fallback, toRunFormat({preset: DEFAULT_OUTPAINT_PRESET}));
  assert.equal(fallback.width, 1920);
  assert.equal(fallback.height, 600);
});

// Extend Canvas contains the whole source rather than cropping it, so a source
// at least as wide as it is tall fills a portrait target edge to edge. A
// left-third band is then entirely preserved pixels and no placement avoids it,
// which made the fixed 'Left third' default a guaranteed failure on every
// portrait preset.
test('a portrait target moves a side safe area onto the axis it actually frees', () => {
  assert.equal(safeAreaForTarget(1080, 1920, 'Left third'), 'Upper third');
  assert.equal(safeAreaForTarget(1080, 1350, 'Right third'), 'Upper third');
});

test('a landscape target moves a horizontal band back to the side', () => {
  assert.equal(safeAreaForTarget(1920, 600, 'Upper third'), 'Left third');
  assert.equal(safeAreaForTarget(1920, 600, 'Lower third'), 'Left third');
});

test('a workable safe area is never overridden', () => {
  assert.equal(safeAreaForTarget(1080, 1920, 'Upper third'), 'Upper third');
  assert.equal(safeAreaForTarget(1920, 600, 'Left third'), 'Left third');
  // Center is prompt-only and orientation-neutral, so it always survives.
  assert.equal(safeAreaForTarget(1080, 1920, 'Center'), 'Center');
  assert.equal(safeAreaForTarget(1920, 600, 'Center'), 'Center');
});

test('a square target has no freed axis to prefer, so the choice stands', () => {
  assert.equal(safeAreaForTarget(1080, 1080, 'Left third'), 'Left third');
  assert.equal(safeAreaForTarget(1080, 1080, 'Upper third'), 'Upper third');
});

test('preset sizes resolve for current and legacy stored values', () => {
  assert.deepEqual(presetSize('1080x1920'), {width: 1080, height: 1920});
  assert.deepEqual(presetSize('instagram-story'), {width: 1080, height: 1920});
  assert.deepEqual(presetSize('Story'), {width: 1080, height: 1920});
  assert.equal(presetSize('not-a-preset'), null);
});
