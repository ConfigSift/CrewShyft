import { Suspense } from 'react';
import { cookies } from 'next/headers';
import SetPasswordClient from './SetPasswordClient';
import SetPasswordSkeleton from './SetPasswordSkeleton';

export const dynamic = 'force-dynamic';

export default async function SetPasswordPage() {
  const cookieStore = await cookies();
  const inviteRequired = cookieStore.get('cs_invite_required')?.value === '1';

  return (
    // Next requires a Suspense boundary around client hooks like useSearchParams on route pages.
    <Suspense fallback={<SetPasswordSkeleton />}>
      <SetPasswordClient inviteRequired={inviteRequired} />
    </Suspense>
  );
}
