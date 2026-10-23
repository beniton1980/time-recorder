export type EventType = "CHECK_IN" | "BREAK_START" | "BREAK_END" | "CHECK_OUT";
import type { AttentionReference } from "./attendance-attention";
export type CorrectionIntent = (
  | { category: "MISTAKE"; targetEventId: string; expectedRevisionId: string; eventType: "CHECK_OUT" | "BREAK_START" }
  | { category: "MISSED"; eventType: EventType; occurredAt: string }
  | { category: "MISSED_BREAK"; eventType: "BREAK_START"; occurredAt: string; breakEndedAt: string }
  | { category: "OTHER"; reason: string }) & { attentionSource?: AttentionReference };

type OperationIdentity = { clientRequestId: string; staffId: string; storeId: string };
export type PendingOperation = OperationIdentity & (
  | { kind: "punch"; eventType: EventType; expectedStateVersion?: string; previousCheckoutRequestId?: string }
  | { kind: "correction"; intent: CorrectionIntent }
);
export type OperationResult = {
  id: string;
  event_type?: EventType;
  occurred_at?: string;
  location_status?: string;
  validation_code?: string | null;
  status?: "PENDING" | "APPROVED" | "REJECTED" | "RESOLVED";
  has_saved_corrections?: boolean;
  outcome?: "CORRECTED" | "NO_CHANGE";
  requested_event_type?: EventType;
};

type OperationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const isEvent = (value: unknown): value is EventType =>
  typeof value === "string" && ["CHECK_IN", "BREAK_START", "BREAK_END", "CHECK_OUT"].includes(value);
const key = (staffId: string, storeId: string) => `onogami.pending-operation.v1:${storeId}:${staffId}`;

// Only retry intent is kept for the lifetime of this tab. Never persist LINE/QR
// credentials, names or GPS. Completed operations are removed immediately.
function parseOperation(raw: string): PendingOperation | null {
  if (raw.length > 4096) return null;
  const value = JSON.parse(raw) as Partial<PendingOperation>;
  if (!value || !isUuid(value.clientRequestId) || !isUuid(value.staffId) || !isUuid(value.storeId)) return null;
  const identity = { clientRequestId: value.clientRequestId, staffId: value.staffId, storeId: value.storeId };
  if (value.kind === "punch" && isEvent(value.eventType)) {
    if (value.previousCheckoutRequestId !== undefined &&
      (value.eventType !== "CHECK_IN" || !isUuid(value.previousCheckoutRequestId))) return null;
    if (value.expectedStateVersion !== undefined &&
      (typeof value.expectedStateVersion !== "string" || !/^\d{1,12}(?:\.\d{1,6})?$/.test(value.expectedStateVersion))) return null;
    // Keep old journals readable for result lookup. The API rejects a new write
    // without a version; it never silently assigns the current state to a retry.
    return { ...identity, kind: "punch", eventType: value.eventType, expectedStateVersion: value.expectedStateVersion,
      ...(value.previousCheckoutRequestId ? { previousCheckoutRequestId: value.previousCheckoutRequestId } : {}) };
  }
  if (value.kind !== "correction" || !value.intent) return null;
  const intent = value.intent;
  const source = intent.attentionSource;
  if (source !== undefined && (!source || !isUuid(source.eventId) || typeof source.revision !== "string"
    || !/^[a-f0-9]{32}$/.test(source.revision) || !["MISSED", "OTHER"].includes(intent.category))) return null;
  const provenance = source ? { attentionSource: { eventId: source.eventId, revision: source.revision } } : {};
  if (intent.category === "MISTAKE" && isUuid(intent.targetEventId) && isUuid(intent.expectedRevisionId)
    && (intent.eventType === "CHECK_OUT" || intent.eventType === "BREAK_START")) {
    return { ...identity, kind: "correction", intent: {
      category: "MISTAKE", targetEventId: intent.targetEventId,
      expectedRevisionId: intent.expectedRevisionId, eventType: intent.eventType,
    } };
  }
  if (intent.category === "MISSED" && isEvent(intent.eventType)
    && typeof intent.occurredAt === "string" && Number.isFinite(Date.parse(intent.occurredAt))) {
    return { ...identity, kind: "correction", intent: {
      category: "MISSED", eventType: intent.eventType, occurredAt: new Date(intent.occurredAt).toISOString(), ...provenance,
    } };
  }
  if (intent.category === "MISSED_BREAK" && intent.eventType === "BREAK_START"
    && typeof intent.occurredAt === "string" && Number.isFinite(Date.parse(intent.occurredAt))
    && typeof intent.breakEndedAt === "string" && Number.isFinite(Date.parse(intent.breakEndedAt))
    && Date.parse(intent.breakEndedAt) > Date.parse(intent.occurredAt)) {
    return { ...identity, kind: "correction", intent: {
      category: "MISSED_BREAK", eventType: "BREAK_START", occurredAt: new Date(intent.occurredAt).toISOString(),
      breakEndedAt: new Date(intent.breakEndedAt).toISOString(),
    } };
  }
  if (intent.category === "OTHER" && typeof intent.reason === "string"
    && intent.reason.trim().length > 0 && intent.reason.length <= 500) {
    return { ...identity, kind: "correction", intent: { category: "OTHER", reason: intent.reason, ...provenance } };
  }
  return null;
}

export function readPendingOperation(storage: OperationStorage | null, staffId: string, storeId: string) {
  try {
    const raw = storage?.getItem(key(staffId, storeId));
    const pending = raw ? parseOperation(raw) : null;
    return pending?.staffId === staffId && pending.storeId === storeId ? pending : null;
  } catch { return null; }
}

export function savePendingOperation(storage: OperationStorage | null, operation: PendingOperation) {
  try {
    const clean = parseOperation(JSON.stringify(operation));
    if (clean) storage?.setItem(key(clean.staffId, clean.storeId), JSON.stringify(clean));
  } catch { /* Restricted storage still allows an in-memory retry in this tab. */ }
}

export function clearPendingOperation(storage: OperationStorage | null, operation: PendingOperation) {
  try { storage?.removeItem(key(operation.staffId, operation.storeId)); } catch { /* See above. */ }
}

export function tabOperationStorage(): OperationStorage | null {
  try { return window.sessionStorage; } catch { return null; }
}
