/** Letters/digits only, lowercase — so hyphenation damage from PDF text
 * extraction ("machinegenerated") still equals the real title. */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}0-9]+/gu, "");
}

/**
 * Whether a search hit's title is the reference's title. Exact after
 * normalization, or a short prefix difference (a lost subtitle) — a generous
 * prefix rule would conflate "Strategic classification" with "Strategic
 * classification made practical".
 */
export function titlesRoughlyEqual(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return (
    (na.startsWith(nb) || nb.startsWith(na)) &&
    Math.max(na.length, nb.length) <= Math.min(na.length, nb.length) * 1.25
  );
}
