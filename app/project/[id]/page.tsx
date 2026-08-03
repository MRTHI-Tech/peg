import {notFound} from 'next/navigation';
import {requireOrganization} from '@/lib/workspace';

import {CanvasEditor} from '@/components/editor/CanvasEditor';
import {getWorkflow} from '@/lib/workflow-service';

export default async function ProjectPage({params}: {params: Promise<{id: string}>}) {
  // Protection sits with the resource, not a middleware matcher.
  await requireOrganization();

  const {id} = await params;
  const workflow = getWorkflow(id);
  if (!workflow) notFound();

  return <CanvasEditor workflow={workflow} />;
}
