import { Calendar, Lock } from 'lucide-react';

export default function InviteSkeleton() {
  return (
    <div className="min-h-screen bg-theme-primary relative flex items-center justify-center p-4">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 40%, rgba(245,158,11,0.06) 0%, transparent 70%)',
        }}
      />

      <div className="relative w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mx-auto mb-4 shadow-lg">
            <Calendar className="w-8 h-8 text-zinc-900" />
          </div>
          <h1 className="text-2xl font-bold text-theme-primary">CrewShyft</h1>
          <p className="text-theme-tertiary mt-1">Set up your account</p>
        </div>

        <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-start gap-3 rounded-xl border border-theme-primary bg-theme-tertiary px-4 py-3">
            <div className="mt-0.5 rounded-lg bg-amber-500/10 p-2">
              <Lock className="h-4 w-4 text-amber-400" />
            </div>
            <div className="space-y-2 flex-1">
              <div className="h-4 w-40 rounded bg-theme-hover animate-pulse" />
              <div className="h-3 w-full rounded bg-theme-hover animate-pulse" />
            </div>
          </div>

          <div className="h-12 w-full rounded-lg bg-theme-hover animate-pulse" />
          <div className="mx-auto h-4 w-28 rounded bg-theme-hover animate-pulse" />
        </div>
      </div>
    </div>
  );
}
