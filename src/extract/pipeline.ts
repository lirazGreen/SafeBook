import { classify } from '../classify/docType.ts';
import { inferIssuer, matchCustomerByName, normaliseOrgName } from '../classify/inferIssuer.ts';
import { resolveIssuer, type CustomerPattern } from '../classify/issuer.ts';
import { findTableRegions } from '../pdf/findTable.ts';
import { reconstructTable } from '../pdf/tables.ts';
import type { ParsedPdf } from '../pdf/parse.ts';
import type { DocType } from '../profiles/loader.ts';
import type { ProfileDefinition } from '../profiles/schema.ts';
import { mapItems, type ItemRecord } from './items.ts';
import { parseDate, type DateFormat } from './normalize/date.ts';
import { parseMoney, resolveDocumentCurrency } from './normalize/money.ts';
import { parseNetTerms } from './normalize/netTerms.ts';
import {
  DEFAULT_SECTION_HEADINGS, labelValue, labelledBullets, multilineAfterLabel,
  patternValue, signatureMarker,
} from './strategies/locate.ts';
import { maskSections, keepOnlySection } from './strategies/sections.ts';
import { coerce, type ValueType } from './normalize/coerce.ts';
import { readTwoColumnSignature } from './strategies/twoColumnSignature.ts';
import { dateEnvelope, validate, type ReviewReason } from './validate.ts';
import type { Escalator, FieldSource } from './engine.ts';

export interface PartyRecord {
  role: 'buyer' | 'vendor';
  name: string | null;
  address: string | null;
  shippingAddress: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  signaturePresent: boolean | null;
  signerName: string | null;
  signerTitle: string | null;
  signatureDate: string | null;
}

export interface SpecialTermRecord {
  termType: string;
  ordinal: number | null;
  percent: string | null;
  capValue: string | null;
  capUnit: string | null;
  period: string | null;
  appliesTo: string | null;
  termText: string;
  attributes: Record<string, unknown>;
  pageNo: number | null;
}

export interface FieldTrace {
  value: string | number | boolean | null;
  source: FieldSource | null;
  evidence?: { start: number; end: number; text: string } | undefined;
}

export interface ExtractionResult {
  docType: DocType | null;
  docTypeConfidence: number;
  docTypeSource: 'classified' | 'manual';
  customerId: number | null;
  customerResolution: 'matched' | 'ambiguous' | 'unmatched' | 'manual';
  detectedIssuerName: string | null;
  startDate: string | null;
  endDate: string | null;
  amount: string | null;
  currency: string | null;
  paymentTermsDays: number | null;
  billingFrequency: string | null;
  attributes: Record<string, unknown>;
  parties: PartyRecord[];
  /** boolean for a declared `type: boolean` field such as the order form`s po_required. */
  typeDetails: Record<string, string | boolean | null>;
  items: ItemRecord[];
  specialTerms: SpecialTermRecord[];
  reviewReasons: ReviewReason[];
  reviewNotes: string[];
  fieldTrace: Record<string, FieldTrace>;
  llmCalls: number;
}

export interface PipelineInput {
  parsed: ParsedPdf;
  /** Registered customers, for name matching and pattern fallback. */
  customers: { id: number; slug: string; name: string }[];
  patterns: CustomerPattern[];
  /** Resolves (customerId, docType) -> the active merged definition. */
  resolveProfile: (customerId: number | null, docType: DocType) =>
    Promise<{ profileId: number; definition: ProfileDefinition } | null>;
  /** null in phase 2: escalation then records FIELD_NOT_FOUND instead of calling. */
  escalate: Escalator | null;
  docTypeOverride?: DocType | undefined;
  customerIdOverride?: number | undefined;
}

const str = (v: { text: string } | null) => v?.text ?? null;

/** Parses a date honouring either `input_format` or `input_formats`. */
const dateFrom = (
  text: string,
  spec: { input_format?: DateFormat | undefined; input_formats?: DateFormat[] | undefined } | undefined,
) => parseDate(text, spec?.input_format, spec?.input_formats)?.iso ?? null;

export async function runExtraction(input: PipelineInput): Promise<ExtractionResult> {
  const { rawText, pages } = input.parsed;
  const trace: Record<string, FieldTrace> = {};
  const record = (field: string, value: FieldTrace['value'], source: FieldSource | null,
                  at?: { start: number; end: number } | null) => {
    trace[field] = {
      value, source,
      evidence: at ? { start: at.start, end: at.end, text: rawText.slice(at.start, at.end) } : undefined,
    };
    return value;
  };

  // ---- 1. document type
  const classification = classify(rawText);
  const docType = input.docTypeOverride ?? classification.docType;
  const docTypeSource = input.docTypeOverride !== undefined ? 'manual' as const : 'classified' as const;

  // ---- 2. who issued it
  const inferred = inferIssuer(rawText, docType);
  const byName = inferred.name ? matchCustomerByName(inferred.name, input.customers) : null;
  const byPattern = resolveIssuer(rawText, input.patterns);
  let customerId = input.customerIdOverride ?? byName?.id ?? byPattern.customerId;
  let customerResolution: ExtractionResult['customerResolution'] =
    input.customerIdOverride !== undefined ? 'manual'
      : byName !== null ? 'matched'
      : byPattern.resolution === 'ambiguous' ? 'ambiguous'
      : byPattern.resolution === 'matched' ? 'matched'
      : 'unmatched';
  if (customerId === null && customerResolution === 'matched') customerResolution = 'unmatched';

  const reviewReasons: ReviewReason[] = [];
  if (customerResolution === 'unmatched') reviewReasons.push('UNMATCHED_CUSTOMER');
  if (customerResolution === 'ambiguous') reviewReasons.push('AMBIGUOUS_CUSTOMER');

  // ---- 3. profile: (customer, type) falling back to (NULL, type)
  if (docType === null) {
    return {
      docType: null, docTypeConfidence: classification.confidence, docTypeSource,
      customerId, customerResolution, detectedIssuerName: inferred.name,
      startDate: null, endDate: null, amount: null, currency: null,
      paymentTermsDays: null, billingFrequency: null, attributes: {},
      parties: [], typeDetails: {}, items: [], specialTerms: [],
      reviewReasons, reviewNotes: ['document type could not be determined'],
      fieldTrace: trace, llmCalls: 0,
    };
  }
  const resolved =
    (customerId !== null ? await input.resolveProfile(customerId, docType) : null) ??
    (await input.resolveProfile(null, docType));
  if (resolved === null) throw new Error(`NO_ACTIVE_PROFILE for doc_type=${docType}`);
  const def = resolved.definition;

  // ---- 3b. the text a lookup is allowed to see
  //
  // `ignore_sections` blanks a block that is not part of the contract, and the
  // mask PRESERVES OFFSETS (spaces, not splices) so every evidence span still
  // indexes into the original raw_text. CloudShield's order form carries its own
  // "Purchase Order Information" block with `PO Amount: USD 0.00`; without the
  // mask a generic `Total Amount` synonym from the base profile would match it
  // and store a zero contract total.
  const headings = def.section_headings ?? DEFAULT_SECTION_HEADINGS;
  const searchText =
    def.ignore_sections !== undefined && def.ignore_sections.length > 0
      ? maskSections(rawText, def.ignore_sections, headings)
      : rawText;

  type Spec = NonNullable<ProfileDefinition['fields']>[string];

  /** `in_section` scopes a field INTO a block; everything else reads the mask. */
  const textFor = (spec: Spec | undefined): string =>
    spec?.in_section !== undefined ? keepOnlySection(rawText, spec.in_section, headings) : searchText;

  /**
   * One entry point for every scalar locator, so a new option reaches them all.
   *
   * LABELS FIRST, pattern as the fallback. A label is tied to an explicit
   * statement in the document; a regex over prose is weaker evidence, so it only
   * answers where no label does — the same precedence that already lets a
   * labelled party name beat the inferred issuer.
   */
  const find = (spec: Spec | undefined): { text: string; start: number; end: number } | null => {
    if (spec === undefined) return null;
    const text = textFor(spec);
    const byLabel = labelValue(text, spec.labels ?? [], { occurrence: spec.occurrence });
    if (byLabel !== null) return byLabel;
    return spec.pattern !== undefined ? patternValue(text, spec.pattern) : null;
  };

  /** Applies `type`, with dates still routed through the declared input_format. */
  const typed = (spec: Spec, found: { text: string }): string | boolean | null =>
    spec.type === 'date' || spec.input_format !== undefined || spec.input_formats !== undefined
      ? dateFrom(found.text, spec)
      : coerce(found.text, spec.type as ValueType | undefined);

  // ---- 4. document-level fields
  const field = (name: string) => def.fields?.[name];
  const labelsOf = (name: string) => field(name)?.labels ?? [];

  const startRaw = find(field('start_date'));
  const endRaw = find(field('end_date'));
  const startDate = startRaw ? dateFrom(startRaw.text, field('start_date')) : null;
  const endDate = endRaw ? dateFrom(endRaw.text, field('end_date')) : null;
  record('start_date', startDate, startDate ? 'rule' : null, startRaw);
  record('end_date', endDate, endDate ? 'rule' : null, endRaw);

  const amountRaw = find(field('amount'));
  const money = amountRaw ? parseMoney(amountRaw.text, field('amount')?.money_format) : null;
  const docCurrency = resolveDocumentCurrency(rawText, def.default_currency);
  const currency = money?.currency ?? docCurrency.currency;
  record('amount', money?.amount ?? null, money ? 'rule' : null, amountRaw);
  if (money !== null && money.needsCurrencyResolution && currency === null) {
    reviewReasons.push('AMBIGUOUS_CURRENCY');
  }

  const termsRaw = find(field('payment_terms'));
  let paymentTermsDays = termsRaw ? parseNetTerms(termsRaw.text) : null;
  let llmCalls = 0;
  if (paymentTermsDays === null) {
    // the deterministic rule failed -> escalate. In phase 2 there is no
    // escalator, so this records FIELD_NOT_FOUND rather than calling anything.
    if (input.escalate !== null) {
      const answer = await input.escalate('payment_terms_days', field('payment_terms')?.sections ?? []);
      llmCalls++;
      if (answer !== null && typeof answer.value === 'number') paymentTermsDays = answer.value;
    }
    if (paymentTermsDays === null) reviewReasons.push('FIELD_NOT_FOUND');
  }
  record('payment_terms_days', paymentTermsDays, paymentTermsDays === null ? null : (termsRaw && parseNetTerms(termsRaw.text) !== null ? 'rule' : 'llm'), termsRaw);

  const freqRaw = find(field('billing_frequency'));
  const billingFrequency = str(freqRaw);
  record('billing_frequency', billingFrequency, billingFrequency ? 'rule' : null, freqRaw);

  // ---- 5. parties
  //
  // Order forms use a two-column signature block, which needs GEOMETRY: each
  // line collapses both columns into one string, so "Name:" appears twice with
  // nothing in the text to tell them apart. Read once per role and reused for
  // all four signature fields.
  const allRuns = pages.flatMap((pg) => pg.runs);
  const parties: PartyRecord[] = (['buyer', 'vendor'] as const).map((role) => {
    const spec = def.parties?.[role] ?? {};
    const sigStrategy = spec['signature_present']?.strategy;
    const twoCol =
      sigStrategy === 'two_column_signature'
        ? readTwoColumnSignature(
            allRuns,
            // the issuer's column: an order form is issued by the VENDOR, which
            // sits left, so the buyer is right
            role === 'buyer' ? (spec['signature_present']?.buyer_column ?? 'right') : 'left',
          )
        : null;
    const pick = (f: string) => {
      const s = spec[f];
      if (s === undefined) return null;
      switch (s.strategy) {
        case 'multiline_after_label':
          return multilineAfterLabel(textFor(s), s.labels ?? [], {
            maxLines: s.max_lines ?? 4,
            stopAt: headings,
          });
        case undefined:
        case 'label_value':
          return find(s);
        default:
          // A strategy is DECLARED but not implemented yet. Return null so the
          // field escalates, rather than falling through to a plain label lookup.
          //
          // Falling through was actively harmful: an order form's buyer
          // signer_name is declared with the bare label "Name", which matched
          // the ITEM TABLE HEADER and produced
          // "Start Date End Date Rate Quantity Total amount". Garbage is worse
          // than nothing — "could not tell" and "here is a value" are different
          // answers, and only the first one escalates.
          return null;
      }
    };
    const sigSpec = spec['signature_present'];
    const sig =
      twoCol !== null
        ? (twoCol.signaturePresent === null ? null : { value: twoCol.signaturePresent, at: null })
        : sigSpec === undefined ? null
        : sigSpec.strategy !== undefined && sigSpec.strategy !== 'signature_marker' ? null
        : signatureMarker(textFor(sigSpec), sigSpec.labels ?? []);
    // through pick(), so an unimplemented strategy returns null here too rather
    // than a plain label lookup finding the WRONG column's date
    const dateSpec = spec['signature_date'];
    const sigDateRaw = pick('signature_date');

    const name = str(pick('name'));
    const address = str(pick('address'));
    if (name !== null) record(`${role}.name`, name, 'rule', pick('name'));
    if (address !== null) record(`${role}.address`, address, 'rule', pick('address'));
    if (sig !== null) record(`${role}.signature_present`, sig.value, 'rule', sig.at ?? null);

    return {
      role, name, address,
      shippingAddress: str(pick('shipping_address')),
      contactName: str(pick('contact_name')),
      contactEmail: str(pick('contact_email')),
      contactPhone: str(pick('contact_phone')),
      signaturePresent: sig?.value ?? null,
      signerName: twoCol?.signerName ?? str(pick('signer_name')),
      signerTitle: twoCol?.signerTitle ?? str(pick('signer_title')),
      signatureDate:
        twoCol?.signatureDate !== undefined && twoCol?.signatureDate !== null
          ? dateFrom(twoCol.signatureDate, dateSpec)
          : sigDateRaw ? dateFrom(sigDateRaw.text, dateSpec) : null,
    };
  });

  // The issuer's name is already inferred, and the issuer IS one of these
  // parties — the VENDOR on an order form, the BUYER on a PO. Order forms never
  // label their vendor ("Vendor Name:" does not appear), so without this the
  // vendor row would be empty on a document that plainly names it.
  //
  // Only fills a gap: a label-based value always wins, since it is tied to an
  // explicit statement in the document.
  const issuerRole = docType === 'order_form' ? 'vendor' : 'buyer';
  const issuerParty = parties.find((x) => x.role === issuerRole);
  if (issuerParty !== undefined && issuerParty.name === null && inferred.name !== null) {
    issuerParty.name = inferred.name;
    record(`${issuerRole}.name`, inferred.name, 'rule', null);
  }

  // ---- 6. type-specific details
  const typeDetails: Record<string, string | boolean | null> = {};
  for (const [name, spec] of Object.entries(def.type_fields ?? {})) {
    const found = find(spec);
    if (found === null) { typeDetails[name] = null; continue; }
    typeDetails[name] = typed(spec, found);
    record(`type.${name}`, typeDetails[name], 'rule', found);
  }

  // ---- 6b. optional fields -> documents.attributes
  //
  // The brief's nine fields get typed columns; anything else a profile declares
  // lands in JSONB, so adding one is a YAML change rather than a migration.
  //
  // Captured ONLY when a profile declares it, never speculatively: that is what
  // bounds natural-language capture. Acme's GDPR sentence and CloudShield's
  // Exhibit A definitions stay in raw_text unless someone asks for them.
  const optional: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(def.optional_fields ?? {})) {
    const found = find(spec);
    if (found === null) continue;
    const value = typed(spec, found);
    if (value === null) continue;
    optional[name] = value;
    record(`attributes.${name}`, value, 'rule', found);
  }

  // ---- 7. items
  const terminators = [...labelsOf('amount'), def.special_terms?.section ?? 'Special Terms'];
  const regions = findTableRegions(pages, {
    columnSynonyms: def.items?.column_synonyms ?? {},
    terminators,
    ...(def.items?.column_gap_pt ? { } : {}),
  });
  const table = reconstructTable(regions, {
    ...(def.items?.column_gap_pt !== undefined ? { columnGapPt: def.items.column_gap_pt } : {}),
    ...(def.items?.anchor_column_ratio !== undefined ? { anchorColumnRatio: def.items.anchor_column_ratio } : {}),
  });
  const mapped = mapItems(table, {
    columnSynonyms: def.items?.column_synonyms,
    optionalColumns: def.items?.optional_columns,
    carryDownFields: def.items?.carry_down,
    dateFormat: def.items?.date_format as DateFormat | undefined,
    documentCurrency: currency,
  });
  if (mapped.unmappedHeaders.length > 0) reviewReasons.push('UNMAPPED_COLUMNS');

  // ---- 8. special terms (deterministic: labelled bullets)
  const bullets = labelledBullets(
    rawText,
    def.special_terms?.section ?? 'Special Terms',
    def.special_terms?.type_labels ?? {},
  );
  const specialTerms: SpecialTermRecord[] = bullets.map((b) => {
    const pct = /(\d+(?:\.\d+)?)\s*%/.exec(b.text);
    return {
      termType: b.termType,
      ordinal: b.ordinal,
      percent: pct ? (pct[1] as string) : null,
      capValue: null, capUnit: null,
      period: /per contract year/i.test(b.text) ? 'contract_year'
        : /annually|per year/i.test(b.text) ? 'contract_year' : null,
      appliesTo: null,
      termText: b.text,
      attributes: {},
      pageNo: null,
    };
  });
  if (specialTerms.length === 0 && input.escalate !== null) {
    // order forms number their terms without labels, so the bullet parse finds
    // nothing and this escalates. Phase 6 wires the escalator.
    llmCalls++;
  }

  // ---- 9. dates from the item envelope when the document states none
  let finalStart = startDate;
  let finalEnd = endDate;
  const itemFieldSources: Record<string, string> = {};
  if (finalStart === null || finalEnd === null) {
    const env = dateEnvelope(mapped.items);
    if (finalStart === null && env.start !== null) { finalStart = env.start; itemFieldSources['start_date'] = 'from_items'; }
    if (finalEnd === null && env.end !== null) { finalEnd = env.end; itemFieldSources['end_date'] = 'from_items'; }
  }

  // ---- 10. validate (never blocks)
  const v = validate({
    amount: money?.amount ?? null,
    currency,
    startDate: finalStart,
    endDate: finalEnd,
    items: mapped.items,
    reconcile: def.items?.reconcile,
    tolerance: def.items?.tolerance,
    tolerancePct: def.items?.tolerance_pct,
  });

  return {
    docType,
    docTypeConfidence: classification.confidence,
    docTypeSource,
    customerId,
    customerResolution,
    detectedIssuerName: inferred.name ?? byPattern.detectedIssuerName,
    startDate: finalStart,
    endDate: finalEnd,
    amount: money?.amount ?? null,
    currency,
    paymentTermsDays,
    billingFrequency,
    attributes: {
      ...optional,
      ...(Object.keys(itemFieldSources).length > 0 ? { field_sources: itemFieldSources } : {}),
    },
    parties,
    typeDetails,
    items: mapped.items,
    specialTerms,
    reviewReasons: [...new Set([...reviewReasons, ...v.reasons])],
    reviewNotes: v.notes,
    fieldTrace: trace,
    llmCalls,
  };
}
