import { cn } from "@/lib/utils";

interface SectionLabelProps {
  children: React.ReactNode;
  className?: string;
}

export function SectionLabel({ children, className }: SectionLabelProps) {
  return (
    <p
      className={cn(
        "uppercase tracking-widest text-xs text-gray-500 mb-4",
        className
      )}
    >
      {children}
    </p>
  );
}
