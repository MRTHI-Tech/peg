const assert = require('node:assert/strict');
const test = require('node:test');

const {FORMAT_SELECTOR_OPTIONS, toRunFormat} = require('../lib/formats.ts');

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
