import { Lightbulb } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@deepagents/react-shadcn';

import { TextShimmer } from '../text-shimmer.tsx';
import { useTipValue } from './TipProvider.tsx';

const SHIMMER_DURATION = 1.5;

export function TipLine({ className }: { className?: string }) {
  const tip = useTipValue();
  const [prevTip, setPrevTip] = useState(tip);
  const [shimmerEnabled, setShimmerEnabled] = useState(false);

  if (tip !== prevTip) {
    setPrevTip(tip);
    if (tip) {
      setShimmerEnabled(true);
    }
  }

  useEffect(() => {
    if (!shimmerEnabled) return;
    const timer = setTimeout(
      () => setShimmerEnabled(false),
      SHIMMER_DURATION * 1000,
    );
    return () => clearTimeout(timer);
  }, [shimmerEnabled]);

  return (
    <p
      className={cn(
        'flex items-center justify-center gap-1.5 px-3 text-xs',
        className,
      )}
    >
      <Lightbulb className="size-3 shrink-0" />
      <TextShimmer
        as="span"
        enabled={shimmerEnabled}
        duration={SHIMMER_DURATION}
      >
        Tip: {tip}
      </TextShimmer>
    </p>
  );
}
