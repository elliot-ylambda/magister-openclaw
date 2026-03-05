import { Skeleton } from "@/components/ui/skeleton";

export default function SkillsLoading() {
  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
