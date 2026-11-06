import { deriveAttendanceAttentionRecords, type EffectivePunch } from "./monthly-attendance.mjs";

export type AttentionReference = { eventId: string; revision: string };
export type AttentionSource = AttentionReference & {
  businessDate: string; startedAt: string; breakStartedAt: string | null;
  lastAt: string; lastType: string; current: boolean; today: string; canCorrect: boolean;
  fromRequest?: boolean;
};
export type AttentionRequest = {
  id: string; status: string; operation: string; eventType: string | null;
  requestedAt: string; occurredAt: string | null; hasSavedCorrections: boolean;
  sourceEventId: string | null; matchedEventId: string | null;
  breakStartedAt?: string | null;
  sourceSnapshot?: AttentionSource | null;
};
export type AttentionItem = {
  id: string; bucket: "check" | "waiting"; message: string; continuing: boolean;
  source: AttentionSource | null; requestId: string | null;
  eventType: "CHECK_OUT" | "BREAK_END" | null;
};

// Daily SSoT decides whether attendance is unresolved. The presentation overlay
// excludes normal current work and never turns a pending request into a punch.
export function buildAttendanceAttention(days: { source: AttentionSource; events: EffectivePunch[] }[], requests: AttentionRequest[]) {
  const items: AttentionItem[] = [];
  const shown = new Set<string>();
  for (const { source, events } of days) {
    const assessment = deriveAttendanceAttentionRecords(events)[0];
    if (!assessment || assessment.status !== "NEEDS_REVIEW") continue;
    const onlyOpen = !assessment.sequenceConflict && assessment.openState !== "OFF_DUTY";
    const linked = requests.filter(r => r.sourceEventId === source.eventId || (!r.sourceEventId && r.matchedEventId === source.eventId));
    const pending = linked.filter(r => r.status === "PENDING");
    const coversOpenStep = pending.some(r => r.operation === "REVIEW" || (onlyOpen && (assessment.openState === "ON_BREAK"
      ? r.eventType === "BREAK_END" && r.breakStartedAt != null && Date.parse(r.breakStartedAt) === Date.parse(source.breakStartedAt ?? "")
      : r.eventType === "CHECK_OUT")));
    if (coversOpenStep) {
      for (const r of pending) {
        shown.add(r.id);
        items.push(waitingItem(r, source));
      }
      continue;
    }
    if (source.current && source.businessDate === source.today && onlyOpen) continue;
    const continuing = source.current && source.businessDate < source.today && onlyOpen;
    const breakMissing = assessment.attendanceReasons.includes("UNCLOSED_BREAK");
    const latest = linked.find(r => r.status === "REJECTED");
    items.push({ id: `work:${source.eventId}:${source.revision}`, bucket: "check", source,
      continuing, requestId: latest?.id ?? null,
      eventType: source.canCorrect && onlyOpen ? breakMissing ? "BREAK_END" : "CHECK_OUT" : null,
      message: continuing ? `${source.businessDate}からの勤務は続いていますか？`
        : onlyOpen ? breakMissing ? "休憩終了と退勤の記録がありません" : "退勤の記録がありません"
        : "打刻の順序に確認が必要です",
    });
  }
  // A consultation stays waiting after saved corrections until explicit resolution.
  // Legacy consultations without provenance cannot suppress an unrelated issue.
  for (const request of requests.filter(r => r.status === "PENDING" && !shown.has(r.id))) {
    const source = days.find(d => d.source.eventId === (request.sourceEventId ?? request.matchedEventId))?.source ?? null;
    items.push(waitingItem(request, source));
  }
  return items.sort((a, b) => (b.source?.businessDate ?? "").localeCompare(a.source?.businessDate ?? "") || a.id.localeCompare(b.id));
}

function waitingItem(r: AttentionRequest, source: AttentionSource | null): AttentionItem {
  // A correction/void or a later shift must not relabel a linked consultation
  // as unassigned. Retain the server-validated context captured at submission.
  if (r.sourceSnapshot) source = { ...r.sourceSnapshot, current: false, canCorrect: false, today: "", fromRequest: true };
  return { id: `request:${r.id}`, bucket: "waiting", source, requestId: r.id, continuing: false, eventType: null,
    message: r.hasSavedCorrections ? "打刻の修正は保存済みです。相談の完了をお待ちください"
      : r.operation === "REVIEW" ? source ? "この勤務について相談中です" : "対象未指定の相談が確認待ちです"
      : "修正申請の承認待ちです" };
}

export type ManagerAttentionEvent = EffectivePunch & { current_state: string; staff_status: string };
export type ManagerAttentionRequest = {
  id: string; staff_id: string; operation: string; requested_event_type: string | null;
  requested_at: string; requested_occurred_at: string | null;
  source_event_id: string | null; matched_event_id: string | null; break_started_at: string | null;
};
export type ManagerAttentionItem = {
  staffId: string; legalName: string; staffStatus: string; businessDate: string;
  message: string; continuing: boolean;
};

// Manager navigation uses the same assessment and request coverage as the staff
// notice. Keep all retained days, including people who have since left the store.
export function buildManagerAttendanceAttention(events: ManagerAttentionEvent[], requests: ManagerAttentionRequest[], today: string): ManagerAttentionItem[] {
  const staff = new Map<string, ManagerAttentionEvent[]>();
  for (const event of events) {
    const list = staff.get(event.staff_id) ?? [];
    list.push(event);
    staff.set(event.staff_id, list);
  }
  const result: ManagerAttentionItem[] = [];
  for (const [staffId, punches] of staff) {
    punches.sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime() || a.effective_id.localeCompare(b.effective_id));
    const latest = punches.at(-1)!;
    const grouped = new Map<string, ManagerAttentionEvent[]>();
    for (const punch of punches) {
      const day = grouped.get(punch.business_date) ?? [];
      day.push(punch); grouped.set(punch.business_date, day);
    }
    const days = Array.from(grouped, ([businessDate, day]) => {
      const last = day.at(-1)!;
      const anchor = day.findLast(event => event.event_type === "CHECK_IN") ?? last;
      return { events: day, source: {
        eventId: anchor.effective_id, revision: "", businessDate,
        startedAt: new Date(anchor.occurred_at).toISOString(), lastAt: new Date(last.occurred_at).toISOString(),
        lastType: last.event_type, breakStartedAt: last.event_type === "BREAK_START" ? new Date(last.occurred_at).toISOString() : null,
        current: latest.current_state !== "OFF_DUTY" && last.effective_id === latest.effective_id,
        today, canCorrect: false,
      } };
    });
    const pending = requests.filter(r => r.staff_id === staffId).map(r => ({
      id: r.id, status: "PENDING", operation: r.operation, eventType: r.requested_event_type,
      requestedAt: r.requested_at, occurredAt: r.requested_occurred_at, hasSavedCorrections: false,
      sourceEventId: r.source_event_id, matchedEventId: r.matched_event_id, breakStartedAt: r.break_started_at,
    }));
    for (const item of buildAttendanceAttention(days, pending)) {
      if (item.bucket !== "check" || !item.source) continue;
      result.push({ staffId, legalName: latest.legal_name ?? "", staffStatus: latest.staff_status,
        businessDate: item.source.businessDate, continuing: item.continuing,
        message: item.continuing ? "勤務が続いているか確認してください" : item.message,
      });
    }
  }
  return result.sort((a, b) => b.businessDate.localeCompare(a.businessDate) || a.legalName.localeCompare(b.legalName, "ja") || a.staffId.localeCompare(b.staffId));
}
