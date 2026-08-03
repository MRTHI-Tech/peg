import {WorkspacePanel} from '@/components/chrome/AuthPanel';
import {requireUser} from '@/lib/workspace';

export const metadata = {
  title: 'Choose a workspace · PEG',
};

/**
 * The one signed-in page that does NOT require an organization — it is where
 * requireOrganization() sends people to get one.
 */
export default async function WorkspacePage() {
  await requireUser();
  return <WorkspacePanel />;
}
