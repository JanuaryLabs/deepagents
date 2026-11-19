import { useClock } from '@zukhruf/ui';
import { useEffect, useRef, useState } from 'react';

export function useCopyFeedback(timeout = 2000) {
  const clock = useClock();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<unknown>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clock.clearTimeout(timerRef.current);
    };
  }, [clock]);

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    if (timerRef.current) clock.clearTimeout(timerRef.current);
    timerRef.current = clock.setTimeout(() => setCopied(false), timeout);
  };

  return [copied, copy] as const;
}
