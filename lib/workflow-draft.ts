import type {Workflow} from './types';

const DRAFT_VERSION = 1;
const KEY_PREFIX = 'peg:workflow-draft:';
const DATABASE_NAME = 'peg-workflow-drafts';
const STORE_NAME = 'workflows';

interface DraftEnvelope {
  version: number;
  workflow: Workflow;
}

export function workflowFingerprint(workflow: Workflow): string {
  return JSON.stringify({
    id: workflow.id,
    name: workflow.name,
    nodes: workflow.nodes,
    edges: workflow.edges,
    thumbnailUrl: workflow.thumbnailUrl,
  });
}

export function workflowTimestamp(workflow: Workflow): number {
  const value = Date.parse(workflow.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

/** A reload cannot leave a node permanently claiming that an abandoned poll is active. */
export function recoverWorkflow(workflow: Workflow): Workflow {
  return {
    ...workflow,
    nodeCount: workflow.nodes.length,
    nodes: workflow.nodes.map(node =>
      node.status === 'queued' || node.status === 'running'
        ? {...node, status: 'idle', error: undefined}
        : node,
    ),
  };
}

function draftKey(workspaceId: string, workflowId: string): string {
  return `${workspaceId}:${workflowId}`;
}

export function readWorkflowDraft(
  storage: Storage,
  workspaceId: string,
  workflowId: string,
): Workflow | null {
  try {
    const raw = storage.getItem(`${KEY_PREFIX}${draftKey(workspaceId, workflowId)}`);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as Partial<DraftEnvelope>;
    const workflow = envelope.workflow;
    if (
      envelope.version !== DRAFT_VERSION ||
      !workflow ||
      workflow.id !== workflowId ||
      !Array.isArray(workflow.nodes) ||
      !Array.isArray(workflow.edges)
    ) {
      return null;
    }
    return recoverWorkflow(workflow);
  } catch {
    return null;
  }
}

/** Returns false when browser storage is unavailable or the draft exceeds its quota. */
export function writeWorkflowDraft(
  storage: Storage,
  workspaceId: string,
  workflow: Workflow,
): boolean {
  try {
    const envelope: DraftEnvelope = {version: DRAFT_VERSION, workflow};
    storage.setItem(
      `${KEY_PREFIX}${draftKey(workspaceId, workflow.id)}`,
      JSON.stringify(envelope),
    );
    return true;
  } catch {
    return false;
  }
}

let databasePromise: Promise<IDBDatabase> | null = null;

function draftDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open draft storage'));
  });
  return databasePromise;
}

/** Large reference images can exceed localStorage; IndexedDB keeps those reload-safe. */
export async function readIndexedWorkflowDraft(
  workspaceId: string,
  workflowId: string,
): Promise<Workflow | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const database = await draftDatabase();
    return await new Promise(resolve => {
      const request = database
        .transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .get(draftKey(workspaceId, workflowId));
      request.onsuccess = () => {
        const envelope = request.result as DraftEnvelope | undefined;
        resolve(
          envelope?.version === DRAFT_VERSION && envelope.workflow?.id === workflowId
            ? recoverWorkflow(envelope.workflow)
            : null,
        );
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function writeIndexedWorkflowDraft(
  workspaceId: string,
  workflow: Workflow,
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    const database = await draftDatabase();
    return await new Promise(resolve => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(
        {version: DRAFT_VERSION, workflow} satisfies DraftEnvelope,
        draftKey(workspaceId, workflow.id),
      );
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    });
  } catch {
    return false;
  }
}
