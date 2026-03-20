import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import BillingClient from './BillingClient';

export default function BillingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center p-4">
          <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
        </div>
      }
    >
      <BillingClient />
    </Suspense>
  );
}
