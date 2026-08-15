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

  async drain(timeoutMs: number = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.runs.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      const active = Array.from(this.runs.values(), (state) => state.promise);
      await Promise.race([
        Promise.allSettled(active),
        new Promise((resolve) => setTimeout(resolve, remainingMs)),
      ]);
    }
    return true;
  }
}
