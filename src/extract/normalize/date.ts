/**
 * Dates are stored as Postgres DATE. The brief's `mm-dd-yyyy` is an OUTPUT
 * format, applied once at the API boundary — storing strings would break
 * ordering and range queries.
 *
 * Formats are a closed registry: a customer writing `15/03/2025` (D/M/Y) needs a
 * new entry here. That is a code change, but it fails SAFE — an unregistered
 * shape returns null and the field is flagged rather than guessed at.
 */
export type DateFormat = 'long_month' | 'short_month_compact' | 'slash_mdy' | 'dash_mdy';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Plausible contract window. `01-01-1900` is a valid date and a certain parse slip. */
export const MIN_YEAR = 1990;
export const MAX_YEAR = 2050;

export interface ParsedDate {
  /** ISO `yyyy-mm-dd`, for Postgres DATE. */
  iso: string;
  /** True when the input could be read as either M/D or D/M and we could not tell. */
  ambiguous: boolean;
}

const PATTERNS: Record<DateFormat, RegExp> = {
  // "January 1, 2025" · "June 22, 2023"
  long_month: /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/,
  // "Jan 1,2025" — abbreviated, often with no space after the comma
  short_month_compact: /^([A-Za-z]{3})\.?\s*(\d{1,2}),\s*(\d{4})$/,
  // "3/1/2025" — not zero-padded
  slash_mdy: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  // "02-15-2025"
  dash_mdy: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
};

function valid(y: number, m: number, d: number): boolean {
  if (y < MIN_YEAR || y > MAX_YEAR) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  // rejects 02-30 rather than rolling it over to March
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Parses a date in one of the declared formats. When no format is declared each
 * is tried in turn — and a numeric date whose parts are BOTH <= 12 is reported
 * `ambiguous`, because `3/1/2025` could be 1 March or 3 January and guessing
 * would silently shift every date in the document.
 */
export function parseDate(
  raw: string,
  format?: DateFormat | undefined,
  /**
   * Candidate formats when no single one is declared. A profile often knows the
   * SET a customer uses without knowing which applies to a given field — Acme's
   * document dates are long_month while its item dates are short_month_compact.
   * Narrowing the candidates still removes the ambiguity flag, because none of
   * the listed formats can read the same string two ways.
   */
  formatCandidates?: DateFormat[] | undefined,
): ParsedDate | null {
  const text = raw.trim();
  const declared = format !== undefined || (formatCandidates !== undefined && formatCandidates.length > 0);
  const formats: DateFormat[] = format
    ? [format]
    : formatCandidates !== undefined && formatCandidates.length > 0
      ? formatCandidates
      : (Object.keys(PATTERNS) as DateFormat[]);

  for (const f of formats) {
    const m = PATTERNS[f].exec(text);
    if (!m) continue;

    if (f === 'long_month' || f === 'short_month_compact') {
      const month = MONTHS[(m[1] as string).slice(0, 3).toLowerCase()];
      if (month === undefined) continue;
      const day = Number(m[2]);
      const year = Number(m[3]);
      if (!valid(year, month, day)) return null;
      return { iso: iso(year, month, day), ambiguous: false };
    }

    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3]);
    // declared format => trust it; otherwise flag the genuinely ambiguous case
    const ambiguous = !declared && a <= 12 && b <= 12 && a !== b;
    if (!valid(year, a, b)) return null;
    return { iso: iso(year, a, b), ambiguous };
  }
  return null;
}

/** The brief's output format, applied at the API boundary only. */
export function formatMmDdYyyy(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${m}-${d}-${y}`;
}
