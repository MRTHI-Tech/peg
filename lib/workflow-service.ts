/**
 * The single boundary between the UI and the backend.
 *
 * Today every function resolves from fixtures in `mock-data.ts`. When the real
 * integrations land, only this file changes:
 *
 *   listWorkflows/getWorkflow → B2-backed workflow documents
 *   runNodes                  → POST to the Genblaze orchestration service,
 *                               which writes each output to B2 and returns the
 *                               AssetRef + Provenance per node
 *
 * Genblaze is a Python SDK, so `runNodes` will call a Next.js route handler that
 * proxies to a Python service rather than importing it directly.
 */

import {HERO_WORKFLOW, WORKFLOWS} from './mock-data';
import type {Workflow} from './types';

export function listWorkflows(): Workflow[] {
  return WORKFLOWS;
}

export function getWorkflow(id: string): Workflow | undefined {
  return WORKFLOWS.find(w => w.id === id) ?? (id === HERO_WORKFLOW.id ? HERO_WORKFLOW : undefined);
}
