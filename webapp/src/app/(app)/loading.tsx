import { Skeleton } from "@/components/ui/skeleton";

export default function AppLoading() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-6 p-6">
        <div className="flex justify-end">
          <Skeleton className="h-10 w-48 rounded-2xl" />
        </div>
        <div className="flex justify-start">
          <Skeleton className="h-24 w-80 rounded-2xl" />
        </div>
        <div className="flex justify-end">
          <Skeleton className="h-10 w-64 rounded-2xl" />
        </div>
        <div className="flex justify-start">
          <Skeleton className="h-32 w-96 rounded-2xl" />
        </div>
      </div>
      <div className="border-t p-4">
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    </div>
  );
}
