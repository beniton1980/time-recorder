export type PayrollPeriod = { start: string; end: string };
export function currentPayrollPeriod(closingRule: string, today: string): PayrollPeriod;
