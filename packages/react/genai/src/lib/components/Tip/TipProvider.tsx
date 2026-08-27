import type React from 'react';
import {
  type PropsWithChildren,
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';

import { useAgent, useAgentStatus } from '../../chat/agent-context.tsx';

export interface Tip<C = unknown> {
  id: string;
  content: (context: C) => Promise<string>;
  cooldownSessions: number;
  isRelevant: (context: C) => Promise<boolean>;
}

export const TipValueContext = createContext<string>('');

export function useTipValue(): string {
  return use(TipValueContext);
}

const HISTORY_KEY = 'tips:history';
const SESSION_KEY = 'tips:session';

type TipHistory = Record<string, number>;

function readHistory(): TipHistory {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeShown(tipId: string, session: number): void {
  try {
    const history = readHistory();
    history[tipId] = session;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* noop */
  }
}

function resolveSession(chatId: string): number {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const state: { id: string; n: number } = raw
      ? JSON.parse(raw)
      : { id: '', n: 0 };
    if (state.id !== chatId) {
      state.id = chatId;
      state.n += 1;
      localStorage.setItem(SESSION_KEY, JSON.stringify(state));
    }
    return state.n;
  } catch {
    return 0;
  }
}

function staleness(
  tipId: string,
  session: number,
  history: TipHistory,
): number {
  const lastShown = history[tipId];
  if (lastShown == null) return Infinity;
  return session - lastShown;
}

async function selectTip<C>(
  tips: Tip<C>[],
  context: C,
  session: number,
): Promise<{ id: string; text: string } | null> {
  const history = readHistory();

  const flags = await Promise.all(tips.map((t) => t.isRelevant(context)));
  const relevant = tips.filter((_, i) => flags[i]);
  if (relevant.length === 0) return null;

  const eligible = relevant.filter(
    (t) => staleness(t.id, session, history) >= t.cooldownSessions,
  );

  const pool = eligible.length > 0 ? eligible : relevant;

  pool.sort(
    (a, b) =>
      staleness(b.id, session, history) - staleness(a.id, session, history),
  );

  const selected = pool[0];
  const text = await selected.content(context);
  return { id: selected.id, text };
}

export function TipProvider<C>({
  tips,
  streaming,
  chatId,
  context,
  children,
}: {
  tips: Tip<C>[];
  streaming: boolean;
  chatId: string;
  context: C;
  children: React.ReactNode;
}) {
  const [session] = useState(() => resolveSession(chatId));
  const [tip, setTip] = useState('');
  const prevStreaming = useRef(false);
  const selecting = useRef(false);

  const pick = useEffectEvent(() => {
    if (selecting.current) return;
    selecting.current = true;
    selectTip(tips, context, session)
      .then((result) => {
        if (result) {
          setTip(result.text);
          writeShown(result.id, session);
        }
      })
      .finally(() => {
        selecting.current = false;
      });
  });

  useEffect(() => {
    pick();
  }, []);

  useEffect(() => {
    const justStarted = streaming && !prevStreaming.current;
    prevStreaming.current = streaming;
    if (!justStarted) return;
    pick();
  }, [streaming]);

  return <TipValueContext value={tip}>{children}</TipValueContext>;
}

export function Tips<C>({
  tips,
  context,
  children,
}: PropsWithChildren<{
  tips: Tip<C>[];
  context: C;
}>) {
  const { chatId } = useAgent();
  const { status } = useAgentStatus();
  const streaming = status === 'streaming' || status === 'submitted';
  return (
    <TipProvider
      tips={tips}
      streaming={streaming}
      chatId={chatId ?? ''}
      context={context}
    >
      {children}
    </TipProvider>
  );
}
