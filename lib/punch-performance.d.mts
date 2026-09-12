export function measurePunchStage<T>(stage: "line" | "session" | "location" | "send" | "total", task: () => Promise<T>): Promise<T>;
