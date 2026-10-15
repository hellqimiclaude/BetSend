/**
 * Work email addresses.
 *
 * The address is the identity: it is what people sign in with, what the
 * recipient picker matches on, and — because only the office mail system can
 * deliver to it — what proves somebody works here. That last point is why the
 * allowed domains matter; they replace a hand-curated staff list.
 */

// Deliberately permissive on the local part (real addresses are stranger than
// people expect) and strict about the shape: one @, a dotted domain, no
// spaces or angle brackets.
const EMAIL_RE = /^[^\s@<>,;"]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export interface EmailResult {
  ok: boolean;
  value: string;
  key: string;
  error?: string;
}

export function normalizeEmail(raw: string): string {
  return String(raw ?? '').trim().replace(/^<|>$/g, '');
}

export function emailKey(raw: string): string {
  return normalizeEmail(raw).toLocaleLowerCase();
}

export function emailDomain(raw: string): string {
  const at = normalizeEmail(raw).lastIndexOf('@');
  return at < 0 ? '' : normalizeEmail(raw).slice(at + 1).toLocaleLowerCase();
}

export function validateEmail(raw: string): EmailResult {
  const value = normalizeEmail(raw);
  if (!value) return { ok: false, value, key: '', error: 'Please enter your work email address.' };
  if (value.length > 254) return { ok: false, value, key: '', error: 'That address is too long.' };
  if (!EMAIL_RE.test(value)) {
    return { ok: false, value, key: '', error: "That does not look like an email address." };
  }
  return { ok: true, value, key: value.toLocaleLowerCase() };
}

/**
 * Is this address inside the office? An empty allowlist means the check is
 * off, which is only sensible on a closed LAN.
 */
export function isAllowedDomain(raw: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const domain = emailDomain(raw);
  return allowed.some((entry) => {
    const candidate = entry.trim().toLocaleLowerCase().replace(/^@/, '');
    if (!candidate) return false;
    // "company.com" also admits "post.company.com".
    return domain === candidate || domain.endsWith(`.${candidate}`);
  });
}

/**
 * Derive the display name from an address, so `j.johnson@acme.com` shows up
 * as `J.Johnson` without anybody typing it twice. Falls back to the whole
 * local part when it is not in that shape.
 */
export function displayNameFromEmail(raw: string): string {
  const local = normalizeEmail(raw).split('@')[0] ?? '';
  const cleaned = local.replace(/[._-]+/g, '.').replace(/^\.|\.$/g, '');
  const parts = cleaned.split('.').filter(Boolean);

  const capitalise = (word: string) =>
    word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase();

  if (parts.length >= 2) {
    // j.johnson -> J.Johnson ; john.johnson -> J.Johnson
    const surname = parts[parts.length - 1];
    return `${parts[0].charAt(0).toLocaleUpperCase()}.${capitalise(surname)}`;
  }
  return capitalise(parts[0] ?? local) || local;
}

/** Parse a pasted list of addresses, optionally `Display Name,email`. */
export function parseEmailList(input: string): {
  valid: { email: string; key: string; name: string }[];
  invalid: { line: string; error: string }[];
} {
  const valid: { email: string; key: string; name: string }[] = [];
  const invalid: { line: string; error: string }[] = [];
  const seen = new Set<string>();

  for (const rawLine of String(input ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^["']|["']$/g, ''));
    // The address is whichever cell has an @; everything else is a name.
    const addressCell = cells.find((c) => c.includes('@'));
    if (!addressCell) {
      if (/^(name|email|e-mail|address|user)$/i.test(cells[0])) continue; // header row
      invalid.push({ line, error: 'No email address on this line.' });
      continue;
    }

    const check = validateEmail(addressCell);
    if (!check.ok) {
      invalid.push({ line, error: check.error ?? 'Invalid address.' });
      continue;
    }
    if (seen.has(check.key)) continue;
    seen.add(check.key);

    const nameCell = cells.find((c) => c && c !== addressCell);
    valid.push({
      email: check.value,
      key: check.key,
      name: nameCell || displayNameFromEmail(check.value),
    });
  }

  return { valid, invalid };
}
