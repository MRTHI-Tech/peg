const assert = require('node:assert/strict');
const test = require('node:test');

const {
  executeInDependencyOrder,
  planDependencyOrder,
} = require('../lib/graph-execution.ts');

const FAN_OUT_EDGES = [
  {fromNode: 'plate', toNode: 'desktop'},
  {fromNode: 'plate', toNode: 'mobile'},
];

test('orders a shared plate before both breakpoint branches', () => {
  const plan = planDependencyOrder(['mobile', 'desktop', 'plate'], FAN_OUT_EDGES);

  assert.deepEqual(plan, {
    ordered: ['plate', 'mobile', 'desktop'],
    blocked: [],
  });
});

test('each branch reads the plate result written by the preceding step', async () => {
  let plateAssetKey;
  const observed = [];

  const summary = await executeInDependencyOrder({
    ids: ['desktop', 'plate', 'mobile'],
    edges: FAN_OUT_EDGES,
    run: async id => {
      if (id === 'plate') plateAssetKey = 'peg/runs/fresh/assets/plate.png';
      else observed.push([id, plateAssetKey]);
      return true;
    },
  });

  assert.deepEqual(observed, [
    ['desktop', 'peg/runs/fresh/assets/plate.png'],
    ['mobile', 'peg/runs/fresh/assets/plate.png'],
  ]);
  assert.deepEqual(summary.failed, []);
});

test('a failed plate skips its dependants without running them', async () => {
  const ran = [];
  const summary = await executeInDependencyOrder({
    ids: ['plate', 'desktop', 'mobile'],
    edges: FAN_OUT_EDGES,
    run: async id => {
      ran.push(id);
      return id !== 'plate';
    },
  });

  assert.deepEqual(ran, ['plate']);
  assert.deepEqual(summary.skipped, ['desktop', 'mobile']);
});

test('one failed branch does not cancel its sibling', async () => {
  const ran = [];
  const summary = await executeInDependencyOrder({
    ids: ['plate', 'desktop', 'mobile'],
    edges: FAN_OUT_EDGES,
    run: async id => {
      ran.push(id);
      return id !== 'desktop';
    },
  });

  assert.deepEqual(ran, ['plate', 'desktop', 'mobile']);
  assert.deepEqual(summary.completed, ['plate', 'mobile']);
  assert.deepEqual(summary.failed, ['desktop']);
});

test('cycles are rejected without spending a run', async () => {
  const ran = [];
  const skipped = [];

  await executeInDependencyOrder({
    ids: ['a', 'b'],
    edges: [
      {fromNode: 'a', toNode: 'b'},
      {fromNode: 'b', toNode: 'a'},
    ],
    run: async id => {
      ran.push(id);
      return true;
    },
    onSkip: (id, reason) => skipped.push([id, reason.kind]),
  });

  assert.deepEqual(ran, []);
  assert.deepEqual(skipped, [
    ['a', 'dependency-cycle'],
    ['b', 'dependency-cycle'],
  ]);
});
