import { carryDown, type TableResult } from '../pdf/tables.ts';
import { parseDate, type DateFormat } from './normalize/date.ts';
import { parseMoney } from './normalize/money.ts';

/**
 * Maps a reconstructed table onto item records using the profile's
 * `column_synonyms`, so a customer's own header wording never needs to match
 * ours exactly.
 */
export interface ItemRecord {
  lineNo: number;
  productName: string | null;
  quantity: string | null;
  unitPrice: string | null;
  totalAmount: string | null;
  currency: string | null;
  itemStartDate: string | null;
  itemEndDate: string | null;
  attributes: Record<string, string>;
  /** Only values NOT read directly off the page. Empty => all from the document. */
  fieldSources: Record<string, string>;
}

export interface ItemMappingResult {
  items: ItemRecord[];
  /** logical field -> column index. */
  columnMap: Record<string, number>;
  /** Header cells no synonym claimed. */
  unmappedHeaders: string[];
}

/** Strips footnote markers and collapses whitespace: `Total Price **` -> `total price`. */
const normaliseHeader = (s: string) =>
  s.toLowerCase().replace(/[*†‡]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Resolves one header cell to a logical field.
 *
 * Takes the LONGEST matching synonym, which matters because synonym lists
 * overlap: `total_amount` lists "Amount" while `unit_price` lists "Unit Price",
 * and CloudShield's header reads "Monthly / Unit Price **". Shortest-match or
 * first-match would mis-assign those.
 */
function resolveHeader(
  cell: string,
  synonyms: Record<string, string[]>,
): { field: string; score: number } | null {
  const h = normaliseHeader(cell);
  if (h.length === 0) return null;
  let best: { field: string; score: number } | null = null;
  for (const [field, list] of Object.entries(synonyms)) {
    for (const syn of list) {
      const s = normaliseHeader(syn);
      if (s.length === 0) continue;
      const hit = h === s || h.startsWith(s) || h.includes(s);
      if (!hit) continue;
      if (best === null || s.length > best.score) best = { field, score: s.length };
    }
  }
  return best;
}

export function mapItems(
  table: TableResult,
  options: {
    columnSynonyms?: Record<string, string[]>;
    optionalColumns?: Record<string, string[]>;
    carryDownFields?: string[];
    dateFormat?: DateFormat;
    documentCurrency?: string | null;
  } = {},
): ItemMappingResult {
  const synonyms = options.columnSynonyms ?? {};
  const optional = options.optionalColumns ?? {};
  const header = table.header ?? [];

  const columnMap: Record<string, number> = {};
  const optionalMap: Record<string, number> = {};
  const unmappedHeaders: string[] = [];

  header.forEach((cell, index) => {
    const core = resolveHeader(cell, synonyms);
    if (core !== null && !(core.field in columnMap)) { columnMap[core.field] = index; return; }
    const extra = resolveHeader(cell, optional);
    if (extra !== null && !(extra.field in optionalMap)) { optionalMap[extra.field] = index; return; }
    if (normaliseHeader(cell).length > 0) unmappedHeaders.push(cell);
  });

  // Sparse columns inherit from the row above BEFORE mapping, so the inherited
  // value lands in the record and is marked in fieldSources.
  const carryIndexes = (options.carryDownFields ?? [])
    .map((f) => optionalMap[f] ?? columnMap[f])
    .filter((i): i is number => i !== undefined);
  const inherited = carryIndexes.length > 0 ? carryDown(table.rows, carryIndexes) : new Map();
  const indexToField = new Map<number, string>([
    ...Object.entries(columnMap).map(([f, i]) => [i, f] as [number, string]),
    ...Object.entries(optionalMap).map(([f, i]) => [i, f] as [number, string]),
  ]);

  const cellAt = (cells: string[], index: number | undefined) =>
    index === undefined ? null : (cells[index] ?? '').trim() || null;

  const items: ItemRecord[] = table.rows.map((row, i) => {
    const money = (idx: number | undefined) => {
      const raw = cellAt(row.cells, idx);
      return raw === null ? null : parseMoney(raw);
    };
    const date = (idx: number | undefined) => {
      const raw = cellAt(row.cells, idx);
      if (raw === null) return null;
      return parseDate(raw, options.dateFormat)?.iso ?? null;
    };
    const unit = money(columnMap['unit_price']);
    const total = money(columnMap['total_amount']);
    const qty = cellAt(row.cells, columnMap['quantity']);

    const attributes: Record<string, string> = {};
    for (const [field, index] of Object.entries(optionalMap)) {
      const v = cellAt(row.cells, index);
      if (v !== null) attributes[field] = v;
    }

    const fieldSources: Record<string, string> = {};
    for (const idx of inherited.get(i) ?? []) {
      const field = indexToField.get(idx);
      if (field !== undefined) fieldSources[field] = 'inherited';
    }

    return {
      lineNo: i + 1,
      productName: cellAt(row.cells, columnMap['product_name']),
      quantity: qty === null ? null : (qty.replace(/[^\d.-]/g, '') || null),
      unitPrice: unit?.amount ?? null,
      totalAmount: total?.amount ?? null,
      currency: total?.currency ?? unit?.currency ?? options.documentCurrency ?? null,
      itemStartDate: date(columnMap['item_start_date']),
      itemEndDate: date(columnMap['item_end_date']),
      attributes,
      fieldSources,
    };
  });

  return { items, columnMap, unmappedHeaders };
}
