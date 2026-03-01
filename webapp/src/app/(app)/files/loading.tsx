import { Skeleton } from "@/components/ui/skeleton";

export default function FilesLoading() {
  return (
    <div className="flex h-[calc(100vh-3rem)] overflow-hidden">
      {/* File tree skeleton */}
      <div className="w-72 border-r border-border p-4 space-y-3">
        <Skeleton className="h-5 w-20" />
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-7" style={{ marginLeft: i % 3 ? 16 : 0 }} />
          ))}
        </div>
      </div>
      {/* Editor skeleton */}
      <div className="flex-1 p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[60vh]" />
      </div>
    </div>
  );
}
