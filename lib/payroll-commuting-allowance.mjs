function within(term, date) {
  return term.effectiveFrom <= date && (term.effectiveTo == null || date <= term.effectiveTo);
}

function validTerm(term) {
  return term && typeof term.id === "string"
    && (term.method === "MONTHLY_PASS" || term.method === "PER_WORKDAY_GAS")
    && Number.isSafeInteger(term.amountYen) && term.amountYen >= 0
    && typeof term.effectiveFrom === "string"
    && (term.effectiveTo == null || typeof term.effectiveTo === "string")
    && term.basisConfirmed === true;
}

export function calculateCommutingAllowance({ terms, payableDates, periodStart, periodEnd }) {
  if (!Array.isArray(terms) || !Array.isArray(payableDates)) throw new TypeError("commuting terms and payable dates must be arrays");
  const overlapping = terms.filter((term) => term.effectiveFrom <= periodEnd && (term.effectiveTo == null || term.effectiveTo >= periodStart));
  if (overlapping.length === 0) return { status: "CONFIRMED", reviewReasons: [], amountYen: 0, snapshot: null };
  if (overlapping.some((term) => !validTerm(term))) return { status: "NEEDS_REVIEW", reviewReasons: ["COMMUTING_ALLOWANCE_BASIS_UNCONFIRMED"], amountYen: 0, snapshot: null };
  const methods = new Set(overlapping.map((term) => term.method));
  if (methods.size !== 1) return { status: "NEEDS_REVIEW", reviewReasons: ["COMMUTING_ALLOWANCE_TERM_AMBIGUOUS"], amountYen: 0, snapshot: null };
  const method = overlapping[0].method;
  if (method === "MONTHLY_PASS") {
    const matches = overlapping.filter((term) => within(term, periodStart) && within(term, periodEnd));
    if (matches.length !== 1 || overlapping.length !== 1 || payableDates.length === 0) {
      return { status: "NEEDS_REVIEW", reviewReasons: [payableDates.length === 0 ? "COMMUTING_MONTHLY_PASS_NO_ATTENDANCE" : "COMMUTING_ALLOWANCE_TERM_AMBIGUOUS"], amountYen: 0, snapshot: null };
    }
    const term = matches[0];
    return { status: "CONFIRMED", reviewReasons: [], amountYen: term.amountYen, snapshot: { method, unitAmountYen: term.amountYen, payableDayCount: payableDates.length, termIds: [term.id] } };
  }
  let amountYen = 0;
  const termIds = new Set();
  for (const date of payableDates) {
    const matches = overlapping.filter((term) => within(term, date));
    if (matches.length !== 1) return { status: "NEEDS_REVIEW", reviewReasons: ["COMMUTING_ALLOWANCE_TERM_MISSING_OR_AMBIGUOUS"], amountYen: 0, snapshot: null };
    amountYen += matches[0].amountYen;
    if (!Number.isSafeInteger(amountYen)) throw new RangeError("commuting allowance exceeds safe yen range");
    termIds.add(matches[0].id);
  }
  return { status: "CONFIRMED", reviewReasons: [], amountYen, snapshot: { method, unitAmountYen: overlapping.length === 1 ? overlapping[0].amountYen : null, payableDayCount: payableDates.length, termIds: [...termIds] } };
}
