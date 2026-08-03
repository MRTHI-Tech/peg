import {auth} from '@clerk/nextjs/server';

import {BrandSetup} from '@/components/brand/BrandSetup';
import {canEditBrand} from '@/lib/workspace';

export const metadata = {
  title: 'Brand kit · PEG',
};

export default async function BrandPage() {
  await auth.protect();
  // Resolved on the server: the client is told what it may do, never asked.
  // The route handlers re-check independently — this only decides what renders.
  return <BrandSetup canEdit={await canEditBrand()} />;
}
