const assert = require('node:assert/strict');
const test = require('node:test');

const {
  readWorkflowDraft,
  recoverWorkflow,
  writeWorkflowDraft,
  workflowFingerprint,
  workflowTimestamp,
} = require('../lib/workflow-draft.ts');

function workflow(overrides = {}) {
  return {
    id: 'wf_1',
    name: 'Campaign',
    nodes: [],
    edges: [],
    nodeCount: 0,
    updatedAt: '2026-08-03T10:00:00Z',
    ...overrides,
  };
}

test('timestamps and derived node counts do not make a graph look edited', () => {
  const first = workflow();
  const second = workflow({updatedAt: '2026-08-03T11:00:00Z', nodeCount: 99});
  assert.equal(workflowFingerprint(first), workflowFingerprint(second));
});

test('reload recovery clears run states that can no longer be polled', () => {
  const recovered = recoverWorkflow(
    workflow({
      nodes: [
        {id: 'queued', status: 'queued', error: 'old'},
        {id: 'running', status: 'running'},
        {id: 'complete', status: 'complete'},
      ],
    }),
  );

  assert.equal(recovered.nodeCount, 3);
  assert.equal(recovered.nodes[0].status, 'idle');
  assert.equal(recovered.nodes[0].error, undefined);
  assert.equal(recovered.nodes[1].status, 'idle');
  assert.equal(recovered.nodes[2].status, 'complete');
});

test('invalid timestamps sort as the oldest draft', () => {
  assert.equal(workflowTimestamp(workflow({updatedAt: 'not-a-date'})), 0);
});

test('browser recovery drafts cannot cross workspace boundaries', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.equal(writeWorkflowDraft(storage, 'org_a', workflow()), true);
  assert.equal(readWorkflowDraft(storage, 'org_b', 'wf_1'), null);
  assert.equal(readWorkflowDraft(storage, 'org_a', 'wf_1').name, 'Campaign');
});
