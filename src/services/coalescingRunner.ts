interface RunState {
  pending: boolean;
  promise: Promise<void>;
}

export class CoalescingRunner {
  private readonly runs = new Map<string, RunState>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const existing = this.runs.get(key);
    if (existing) {
      existing.pending = true;
      return existing.promise;
    }

    const state: RunState = { pending: false, promise: Promise.resolve() };
    this.runs.set(key, state);
    state.promise = (async () => {
      try {
        do {
          state.pending = false;
          await task();
        } while (state.pending);
      } finally {
        this.runs.delete(key);
      }
    })();
    return state.promise;
  }
}
