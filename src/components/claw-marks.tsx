import { cn } from "@/lib/utils";

interface ClawMarksProps {
  className?: string;
}

export function ClawMarks({ className }: ClawMarksProps) {
  return (
    <div className={cn("flex items-center justify-center gap-2", className)}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-10 w-[3px] -rotate-[20deg] rounded-full"
          style={{
            background: "linear-gradient(to bottom, #f59e0b, #ea580c)",
          }}
        />
      ))}
    </div>
  );
}
