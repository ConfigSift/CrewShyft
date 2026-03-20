'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[admin:error]', error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center py-10">
      <div className="w-full max-w-2xl rounded-2xl border border-red-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-red-500">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-zinc-900">Admin page failed to load</h2>
        <p className="mt-2 text-sm text-zinc-600">
          The admin shell is still available, but this page threw an error while rendering or
          fetching data.
        </p>
        {error.message ? (
          <p className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs text-zinc-600">
            {error.message}
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700"
        >
          <RefreshCw className="h-4 w-4" />
          Retry page
        </button>
      </div>
    </div>
  );
}
