/**
 * Payment terms are stored as an integer number of days; the brief's `Net xx` is
 * rendered at the API boundary, exactly like dates.
 *
 * Only the DETERMINISTIC form lives here — `Net 30` stated literally. Prose such
 * as "within thirty (30) days from invoice" deliberately does NOT parse: that
 * failure is what triggers escalation to Claude, which is how a wording nobody
 * anticipated still gets handled.
 */
export function parseNetTerms(raw: string): number | null {
  const m = /\bNet\s*[- ]?\s*(\d{1,3})\b/i.exec(raw);
  if (!m) return null;
  const days = Number(m[1]);
  return days > 0 && days <= 365 ? days : null;
}

export const formatNetTerms = (days: number) => `Net ${days}`;
