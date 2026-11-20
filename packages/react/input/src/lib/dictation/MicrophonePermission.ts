export type MicrophonePermissionState = PermissionState | 'unknown';

export class MicrophonePermission {
  #state: MicrophonePermissionState = 'unknown';

  // A predicting check: the real trial, getUserMedia, would ask the user for
  // the microphone before they click. Only a known 'denied' disables the start.
  readonly subscribe = (listener: () => void) => {
    const unsubscribed = new AbortController();
    navigator.permissions.query({ name: 'microphone' }).then(
      (status) => {
        if (unsubscribed.signal.aborted) {
          return;
        }
        const read = () => {
          this.#state = status.state;
          listener();
        };
        read();
        status.addEventListener('change', read, {
          signal: unsubscribed.signal,
        });
      },
      (error: unknown) => {
        if (!(error instanceof TypeError)) {
          throw error;
        }
      },
    );
    return () => {
      unsubscribed.abort();
    };
  };

  readonly getSnapshot = () => this.#state;
}
