import {
  PollingChangeSource,
  StreamManager,
  type StreamStore,
} from '@deepagents/context';

export function streamsFor(store: StreamStore): StreamManager {
  return new StreamManager({
    store,
    changeSource: new PollingChangeSource({ reads: store }),
  });
}
