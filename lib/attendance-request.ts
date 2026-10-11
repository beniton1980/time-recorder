// A timeout only means the browser could not confirm the response. The server
// may still commit, so callers retain the operation ID and look up its result.
export async function withAttendanceDeadline<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("ATTENDANCE_REQUEST_TIMEOUT"));
      controller.abort();
    }, 15_000);
  });
  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
