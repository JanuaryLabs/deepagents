import { createClock } from '@sinonjs/fake-timers';
import { ClockProvider } from '@zukhruf/ui';
import { type ReactNode, useState } from 'react';

export function FakeClock({ children }: { children: ReactNode }) {
  const [clock] = useState(() => createClock());
  return <ClockProvider clock={clock}>{children}</ClockProvider>;
}
