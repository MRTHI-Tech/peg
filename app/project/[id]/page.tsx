import {randomUUID} from 'node:crypto';
import {redirect} from 'next/navigation';
import {requireOrganization} from '@/lib/workspace';

import {CanvasEditor} from '@/components/editor/CanvasEditor';
import {getWorkflow} from '@/lib/workflow-service';
import {createEmptyWorkflow, NEW_WORKFLOW_ID} from '@/lib/mock-data';

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{id: string}>;
  searchParams: Promise<{new?: string}>;
}) {
  // Protection sits with the resource, not a middleware matcher.
  const workspaceId = await requireOrganization();

  const {id} = await params;
  if (id === NEW_WORKFLOW_ID) {
    // Give the blank canvas a durable identity before it can be edited. The
    // query flag survives only until the first successful autosave.
    redirect(`/project/wf_${randomUUID().replaceAll('-', '')}?new=1`);
  }

  const workflow = getWorkflow(id) ?? createEmptyWorkflow(id);
  const isNew = (await searchParams).new === '1';
  return <CanvasEditor workflow={workflow} workspaceId={workspaceId} isNew={isNew} />;
}
