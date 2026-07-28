/**
 * Office identities are "first initial + dot + last name", e.g. `J.Johnson`.
 * We accept unicode letters in the surname so names like `A.Müller` or
 * `S.O'Brien` work, and we normalise capitalisation so `j.johnson` and
 * `J.JOHNSON` resolve to the same person.
 */

const NAME_RE = /^\p{L}\.\p{L}[\p{L}'’\- ]{0,48}$/u;

export const NAME_PATTERN_SOURCE = "^\\p{L}\\.\\p{L}[\\p{L}'’\\- ]{0,48}$";
export const NAME_EXAMPLE = 'J.Johnson';

export interface NameResult {
  ok: boolean;
  value: string;
  key: string;
  error?: string;
}

function titleCaseSegment(segment: string): string {
  return segment.replace(
    /(^|[\s'’-])(\p{L})/gu,
    (_m, sep: string, ch: string) => sep + ch.toLocaleUpperCase(),
  );
}

/** Trim, collapse whitespace and apply the canonical capitalisation. */
export function normalizeName(raw: string): string {
  const collapsed = String(raw ?? '').trim().replace(/\s+/g, ' ');
  const dot = collapsed.indexOf('.');
  if (dot <= 0) return collapsed;
  const initial = collapsed.slice(0, dot).toLocaleUpperCase();
  const rest = titleCaseSegment(collapsed.slice(dot + 1).toLocaleLowerCase());
  return `${initial}.${rest}`;
}

export function nameKey(raw: string): string {
  return normalizeName(raw).toLocaleLowerCase();
}

export function validateName(raw: string): NameResult {
  const value = normalizeName(raw);
  if (!value) {
    return { ok: false, value, key: '', error: 'Please enter a name.' };
  }
  if (!NAME_RE.test(value)) {
    return {
      ok: false,
      value,
      key: '',
      error: `Names look like ${NAME_EXAMPLE} — one initial, a dot, then the last name.`,
    };
  }
  return { ok: true, value, key: value.toLocaleLowerCase() };
}

/**
 * Parse a pasted block of names: one per line, or CSV where the name is the
 * first column. Blank lines, `#` comments and a leading header row are ignored.
 */
export function parseNameList(input: string): { valid: NameResult[]; invalid: { line: string; error: string }[] } {
  const valid: NameResult[] = [];
  const invalid: { line: string; error: string }[] = [];
  const seen = new Set<string>();

  const lines = String(input ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const firstCell = line.split(/[,;\t]/)[0].trim().replace(/^["']|["']$/g, '');
    if (!firstCell) continue;
    if (/^(name|user|username|users)$/i.test(firstCell)) continue; // CSV header

    const result = validateName(firstCell);
    if (!result.ok) {
      invalid.push({ line: firstCell, error: result.error ?? 'Invalid name.' });
      continue;
    }
    if (seen.has(result.key)) continue;
    seen.add(result.key);
    valid.push(result);
  }

  return { valid, invalid };
}
