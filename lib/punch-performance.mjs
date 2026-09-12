const stages = new Set(["line", "session", "location", "send", "total"]);

// Only the most recent duration per stage, in this browser's memory. No identifiers or upload.
export async function measurePunchStage(stage, task) {
  const clock = globalThis.performance;
  const start = clock?.now();
  try {
    return await task();
  } finally {
    if (stages.has(stage) && start !== undefined && clock?.measure) {
      try {
        const name = `onogami:punch:${stage}`;
        clock.clearMeasures(name);
        clock.measure(name, { start, end: clock.now() });
      } catch { /* Timing must never affect a punch. */ }
    }
  }
}
