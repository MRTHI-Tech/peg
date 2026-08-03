import {notFound} from 'next/navigation';
import {auth} from '@clerk/nextjs/server';

import {CanvasEditor} from '@/components/editor/CanvasEditor';
import {getWorkflow} from '@/lib/workflow-service';

export default async function ProjectPage({params}: {params: Promise<{id: string}>}) {
  // Protection sits with the resource, not a middleware matcher.
  await auth.protect();

  const {id} = await params;
  const workflow = getWorkflow(id);
  if (!workflow) notFound();

  return <CanvasEditor workflow={workflow} />;
}
