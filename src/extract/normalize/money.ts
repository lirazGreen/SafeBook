/**
 * Money is stored as NUMERIC plus a CHAR(3) ISO 4217 code — never a symbol, and
 * never a float. CloudShield's 22916.67 x 12 only reconciles to 275,000.00
 * exactly because nothing is parsed into a JS number along the way to the DB.
 */
export type MoneyFormat = 'symbol_prefix' | 'code_prefix' | 'code_suffix';

/** `$` is genuinely ambiguous across USD/CAD/AUD/NZD/SGD/HKD/MXN. */
const AMBIGUOUS_SYMBOLS = new Set(['$']);

const SYMBOL_TO_CODE: Record<string, string> = {
  '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₪': 'ILS', '₹': 'INR', '₩': 'KRW', '₺': 'TRY',
};

export interface ParsedMoney {
  /** Decimal string, NOT a number — handed to Postgres NUMERIC verbatim. */
  amount: string;
  /** ISO code, or null when the text carried only an ambiguous symbol. */
  currency: string | null;
  /** True when a bare ambiguous symbol was seen and must be resolved elsewhere. */
  needsCurrencyResolution: boolean;
}

const ISO = /\b([A-Z]{3})\b/;

/**
 * Strips grouping separators and normalises the decimal point.
 *
 * Handles the European convention (`1.234,56`) as well as the Anglo one
 * (`1,234.56`) by taking the LAST separator as the decimal point when the tail
 * is 1-2 digits — so `$162,000` stays 162000 while `1.234,56` becomes 1234.56.
 */
function toDecimalString(numeric: string): string | null {
  const cleaned = numeric.replace(/[^\d.,]/g, '');
  if (cleaned.length === 0) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  const lastSep = Math.max(lastComma, lastDot);

  if (lastSep === -1) return cleaned;

  const tail = cleaned.slice(lastSep + 1);
  // a 1-2 digit tail after the last separator means that separator is the decimal
  const isDecimal = tail.length > 0 && tail.length <= 2 && /^\d+$/.test(tail);
  if (!isDecimal) return cleaned.replace(/[.,]/g, '');

  const whole = cleaned.slice(0, lastSep).replace(/[.,]/g, '');
  return `${whole || '0'}.${tail}`;
}

export function parseMoney(raw: string, _format?: MoneyFormat): ParsedMoney | null {
  const text = raw.trim();
  const numericMatch = /[\d][\d.,]*/.exec(text);
  if (!numericMatch) return null;
  const amount = toDecimalString(numericMatch[0]);
  if (amount === null) return null;

  // an explicit ISO code anywhere wins over a symbol, whichever side it is on
  const code = ISO.exec(text.toUpperCase());
  if (code) return { amount, currency: code[1] as string, needsCurrencyResolution: false };

  const symbol = Object.keys(SYMBOL_TO_CODE).find((s) => text.includes(s));
  if (symbol) {
    return { amount, currency: SYMBOL_TO_CODE[symbol] as string, needsCurrencyResolution: false };
  }
  if ([...AMBIGUOUS_SYMBOLS].some((s) => text.includes(s))) {
    return { amount, currency: null, needsCurrencyResolution: true };
  }
  return { amount, currency: null, needsCurrencyResolution: false };
}

/**
 * Resolves a bare `$` using the whole document, per the precedence rule:
 *   1. EXACTLY ONE distinct ISO code in the document -> use it
 *   2. the profile's default_currency
 *   3. null -> AMBIGUOUS_CURRENCY flag
 *
 * Never from a billing address: NovaFleet's buyer is in Toronto, which would
 * yield CAD against a document whose own total reads `$451,000 USD`.
 */
export function resolveDocumentCurrency(
  rawText: string,
  defaultCurrency?: string,
): { currency: string | null; codesFound: string[] } {
  const codes = [...new Set(rawText.match(/\b(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|ILS|INR|SGD|HKD|NZD|MXN)\b/g) ?? [])];
  if (codes.length === 1) return { currency: codes[0] as string, codesFound: codes };
  if (codes.length === 0 && defaultCurrency) return { currency: defaultCurrency, codesFound: codes };
  return { currency: null, codesFound: codes };
}
