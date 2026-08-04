const assert = require('node:assert/strict');
const test = require('node:test');

const {resolveBriefTarget} = require('../lib/brief-context.ts');

/** A Format node targeting a wide desktop hero with the headline on the left. */
const DESKTOP_FORMAT = {
  id: 'fmt',
  type: 'format',
  params: {preset: '1920x600', safeArea: 'Left third', focalPoint: 'Right'},
};

const BRIEF = {id: 'brief', type: 'prompt', params: {value: 'premium savings account'}};
const PLATE = {id: 'plate', type: 'brand-scene', params: {}};

test('finds the canvas the brief is wired to', () => {
  const target = resolveBriefTarget(
    'brief',
    [BRIEF, PLATE, DESKTOP_FORMAT],
    [
      {fromNode: 'brief', toNode: 'plate', toPort: 'prompt'},
      {fromNode: 'fmt', toNode: 'plate', toPort: 'format'},
    ],
  );

  assert.deepEqual(target, {source: 'format', params: DESKTOP_FORMAT.params});
});

test('walks through Art Direct to reach the model that names a canvas', () => {
  // A brief usually reaches its plate through an intermediate text node, so
  // looking only one hop downstream would enhance without any composition.
  const target = resolveBriefTarget(
    'brief',
    [BRIEF, {id: 'direct', type: 'prompt-enhancer', params: {}}, PLATE, DESKTOP_FORMAT],
    [
      {fromNode: 'brief', toNode: 'direct', toPort: 'prompt'},
      {fromNode: 'direct', toNode: 'plate', toPort: 'prompt'},
      {fromNode: 'fmt', toNode: 'plate', toPort: 'format'},
    ],
  );

  assert.equal(target?.source, 'format');
  assert.equal(target?.params.preset, '1920x600');
});

test('falls back to an Extend Canvas node carrying its own target', () => {
  const target = resolveBriefTarget(
    'brief',
    [BRIEF, {id: 'extend', type: 'genfill', params: {outputSize: '1080x1350'}}],
    [{fromNode: 'brief', toNode: 'extend', toPort: 'prompt'}],
  );

  assert.deepEqual(target, {source: 'canvas-node', params: {outputSize: '1080x1350'}});
});

test('a connected Format beats the Extend Canvas node it feeds', () => {
  // Same precedence the run path uses: an explicit Format wins over the size
  // stored on the node, so the brief is composed for what will actually render.
  const target = resolveBriefTarget(
    'brief',
    [BRIEF, {id: 'extend', type: 'genfill', params: {outputSize: '1080x1350'}}, DESKTOP_FORMAT],
    [
      {fromNode: 'brief', toNode: 'extend', toPort: 'prompt'},
      {fromNode: 'fmt', toNode: 'extend', toPort: 'format'},
    ],
  );

  assert.equal(target?.source, 'format');
});

test('an unwired brief resolves no canvas rather than inventing one', () => {
  assert.equal(resolveBriefTarget('brief', [BRIEF], []), undefined);
});

test('ignores an image edge that happens to reach a formatted node', () => {
  // Only the prompt path carries this brief. A plate that merely shares an
  // image with something else must not lend it its canvas.
  const target = resolveBriefTarget(
    'brief',
    [BRIEF, PLATE, DESKTOP_FORMAT],
    [
      {fromNode: 'brief', toNode: 'plate', toPort: 'image'},
      {fromNode: 'fmt', toNode: 'plate', toPort: 'format'},
    ],
  );

  assert.equal(target, undefined);
});

test('survives a cycle in a user-built graph', () => {
  const target = resolveBriefTarget(
    'brief',
    [BRIEF, {id: 'a', type: 'prompt', params: {}}],
    [
      {fromNode: 'brief', toNode: 'a', toPort: 'prompt'},
      {fromNode: 'a', toNode: 'brief', toPort: 'prompt'},
    ],
  );

  assert.equal(target, undefined);
});
