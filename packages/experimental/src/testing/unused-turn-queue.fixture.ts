import {
  type TurnActivity,
  TurnQueue,
  type TurnRef,
} from '@deepagents/experimental/zukhruf';

function unusedQueue(): Error {
  return new Error('this test never schedules a turn');
}

export class UnusedTurnQueue extends TurnQueue {
  override async push(): Promise<void> {
    throw unusedQueue();
  }

  override async getTurnActivity(): Promise<TurnActivity> {
    throw unusedQueue();
  }

  override async getCurrentTurn(): Promise<TurnRef | undefined> {
    throw unusedQueue();
  }

  override async cancel(): Promise<void> {
    throw unusedQueue();
  }

  override async consume(): Promise<AsyncDisposable> {
    throw unusedQueue();
  }

  override async resumeParked(): Promise<void> {
    throw unusedQueue();
  }
}
