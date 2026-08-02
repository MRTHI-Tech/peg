import {notFound} from 'next/navigation';

import {CanvasEditor} from '@/components/editor/CanvasEditor';
import {getWorkflow} from '@/lib/workflow-service';

export default async function ProjectPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const workflow = getWorkflow(id);
  if (!workflow) notFound();

  return <CanvasEditor workflow={workflow} />;
}
