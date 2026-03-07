import { Suspense } from 'react';
import InviteVerifyClient from './InviteVerifyClient';
import InviteSkeleton from './InviteSkeleton';

export const dynamic = 'force-dynamic';

export default function InvitePage() {
  return (
    // Next requires a Suspense boundary around client hooks like useSearchParams on route pages.
    <Suspense fallback={<InviteSkeleton />}>
      <InviteVerifyClient />
    </Suspense>
  );
}
