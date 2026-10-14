/**
 * Resolves a model-supplied quote to character offsets in the stored `raw_text`.
 *
 * This is the check that catches a hallucinated citation: a model that invents a
 * value often invents a plausible quote to go with it, and a quote that is not
 * actually in the document fails here.
 *
 * The subtlety is that a naive `indexOf` produces FALSE REJECTIONS of correct
 * extractions, which is worse than no check at all. Two causes, both present in
 * the sample documents:
 *
 *   1. Line breaks. Acme's payment clause is laid out as
 *        "Payment shall be\nmade within thirty (30) days from invoice."
 *      A model naturally returns it as one line. Verified: raw indexOf == -1.
 *
 *   2. Typographic characters. Acme uses curly quotes (U+201C/U+201D) around
 *      (the "Burst Threshold"); CloudShield uses an en-dash (U+2013). Models
 *      routinely return the ASCII equivalents.
 *
 * So matching happens on a normalised copy, while the returned offsets index the
 * ORIGINAL text — the stored evidence is always the document's real characters.
 */

const PUNCT_FOLD: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",   // curly single
  '“': '"', '”': '"', '„': '"', '‟': '"',   // curly double
  '–': '-', '—': '-', '‒': '-', '−': '-',   // dashes, minus
  ' ': ' ', ' ': ' ', ' ': ' ',                   // fixed-width spaces
  '…': '...',
};

/**
 * Normalised text plus a map from each normalised index back to its index in the
 * original. Runs of whitespace collapse to one space, so the map is not 1:1.
 */
function normalise(source: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    const folded = PUNCT_FOLD[ch] ?? ch;
    if (/\s/.test(folded)) {
      // collapse: emit at most one space per run, and never lead with one
      if (text.length > 0 && !text.endsWith(' ')) {
        text += ' ';
        map.push(i);
      }
      continue;
    }
    for (const c of folded) {
      text += c;
      map.push(i);
    }
  }
  return { text, map };
}

export interface Evidence {
  start: number;
  end: number;
  /** The ORIGINAL document text at [start, end) — not the model's rendering. */
  text: string;
}

export interface EvidenceResolver {
  resolve(quote: string): Evidence | null;
}

/**
 * Build a resolver for one document. Normalising `raw_text` is O(n), so it is
 * done once per document rather than once per field.
 */
export function evidenceResolver(rawText: string): EvidenceResolver {
  const { text: haystack, map } = normalise(rawText);

  return {
    resolve(quote: string): Evidence | null {
      const needle = normalise(quote).text.trim();
      if (needle.length === 0) return null;

      const at = haystack.indexOf(needle);
      if (at === -1) return null;

      // Ambiguity is not a match: if the quote appears more than once we cannot
      // say which occurrence the model meant, and guessing would attach evidence
      // to the wrong place in the document.
      if (haystack.indexOf(needle, at + 1) !== -1) return null;

      const start = map[at] as number;
      const end = (map[at + needle.length - 1] as number) + 1;
      return { start, end, text: rawText.slice(start, end) };
    },
  };
}

/**
 * Does the extracted value actually appear in the text the model cited?
 *
 * Holds for all six LLM-extracted numeric fields in the samples, because legal
 * drafting writes "thirty (30)" precisely to be unambiguous — the numeral sits
 * beside the word. A model answering `Net 30` while quoting the forty-five-day
 * clause is caught here rather than by a confidence score.
 */
export function valueAppearsIn(quote: string, value: number): boolean {
  const digits = quote.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return digits.some((d) => Number(d.replace(/,/g, '')) === value);
}
