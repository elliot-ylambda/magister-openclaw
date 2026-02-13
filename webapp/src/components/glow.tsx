import { cn } from "@/lib/utils";

interface GlowProps {
  className?: string;
  color?: string;
  style?: React.CSSProperties;
}

export function Glow({ className, color = "#f59e0b", style }: GlowProps) {
  return (
    <div
      className={cn("absolute pointer-events-none", className)}
      style={{
        background: `radial-gradient(circle, ${color}33 0%, transparent 70%)`,
        ...style,
      }}
    />
  );
}
