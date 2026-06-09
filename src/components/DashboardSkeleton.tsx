// Pulsing skeleton for the dashboard loading state — matches the real layout
export function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Stat row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-gray-100 bg-gray-50 p-5 h-24" />
        ))}
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
        {/* Left column — agents */}
        <div className="space-y-4">
          <div className="h-5 w-32 rounded bg-gray-100" />
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-gray-100 bg-white p-5 space-y-3">
              <div className="flex justify-between">
                <div className="h-4 w-40 rounded bg-gray-100" />
                <div className="h-4 w-16 rounded bg-gray-100" />
              </div>
              <div className="flex gap-2">
                <div className="h-5 w-20 rounded-full bg-gray-100" />
                <div className="h-5 w-24 rounded-full bg-gray-100" />
                <div className="h-5 w-16 rounded-full bg-gray-100" />
              </div>
              <div className="h-3 w-full rounded bg-gray-50" />
            </div>
          ))}
        </div>

        {/* Right column — tasks + keys */}
        <div className="space-y-6">
          {/* Recent tasks */}
          <div className="rounded-xl border border-gray-100 bg-white p-5 space-y-3">
            <div className="h-4 w-28 rounded bg-gray-100 mb-4" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <div className="space-y-1.5">
                  <div className="h-3 w-32 rounded bg-gray-100" />
                  <div className="h-2.5 w-20 rounded bg-gray-50" />
                </div>
                <div className="h-5 w-16 rounded-full bg-gray-100" />
              </div>
            ))}
          </div>

          {/* API keys */}
          <div className="rounded-xl border border-gray-100 bg-white p-5 space-y-3">
            <div className="h-4 w-20 rounded bg-gray-100 mb-4" />
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="h-3 w-28 rounded bg-gray-100" />
                <div className="h-3 w-16 rounded bg-gray-50" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
