export type ConsultationEvent = { id: string; type: string; at: string; day: string };
export type Consultation = {
  id: string; staffId: string; storeId: string; staffName: string; storeName: string;
  reason: string; requestedAt: string; requestDay: string; status: string; version: string;
  targetDay: string | null; targetId: string | null; resolvedAt: string | null;
  source?: { businessDate: string; startedAt: string; breakStartedAt: string | null } | null;
  outcome: "CORRECTED" | "NO_CHANGE" | null; resolutionReason: string | null;
  changes: { id: string; operation: string; before: ConsultationEvent | null; after: ConsultationEvent | null; reason: string; at: string }[];
};
export function consultationHref(storeId: string, id: string) {
  return `/manager/consultations?${new URLSearchParams({ store_id: storeId, id })}`;
}
