export function TimelineDot({ isLast = false }: { isLast?: boolean }) {
  return (
    <div className="absolute top-0 left-0 flex size-3.5 h-full flex-col items-center">
      <span className="bg-muted-foreground/50 z-10 mt-1 size-2 shrink-0 rounded-full" />
      {!isLast && <span className="bg-border w-px flex-1" />}
    </div>
  );
}
