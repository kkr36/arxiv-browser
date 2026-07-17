/**
 * LaTeX-produced PDFs position an accent as its own spacing glyph before the
 * letter it modifies, so text extraction yields "W ¨uthrich", "S ´anchez",
 * "Peke ˇc" instead of "Wüthrich", "Sánchez", "Pekeč". Recombining them
 * matters everywhere reference text is matched against the outside world:
 * author-year citation keys, title guessing, and metadata search queries all
 * break on the detached form.
 */
const COMBINING_BY_ACCENT: Record<string, string> = {
  "¨": "̈", // ¨ diaeresis
  "´": "́", // ´ acute
  "`": "̀", // ` grave
  "ˆ": "̂", // ˆ circumflex
  "˜": "̃", // ˜ tilde
  "ˇ": "̌", // ˇ caron
  "˘": "̆", // ˘ breve
  "˚": "̊", // ˚ ring above
  "˙": "̇", // ˙ dot above
  "˝": "̋", // ˝ double acute
  "¯": "̄", // ¯ macron
  "¸": "̧", // ¸ cedilla
  "˛": "̨", // ˛ ogonek
};

/** The spacing-accent characters the repair recognizes, as a regex class body
 * (exported for marker detection, which must tolerate still-broken text). */
export const DETACHED_ACCENT_CLASS = Object.keys(COMBINING_BY_ACCENT).join("");

// The stray space appears BEFORE the accent glyph, never between the accent
// and its letter — requiring direct attachment keeps ordinary punctuation
// (backtick quoting, primes) from being misread as an accent.
const DETACHED_RE = new RegExp(
  `(\\p{L} ?)?([${DETACHED_ACCENT_CLASS}])(\\p{L})`,
  "gu",
);

export function repairDetachedDiacritics(text: string): string {
  return text.replace(DETACHED_RE, (whole, before: string | undefined, accent, letter: string) => {
    const composed = (letter + COMBINING_BY_ACCENT[accent]).normalize("NFC");
    // No precomposed form exists — likely not a broken accent at all.
    if (composed.length > 1) return whole;
    if (!before) return composed;
    // The extractor also inserts a stray space before the accent glyph
    // ("W ¨uthrich"). A lowercase accented letter cannot start a word, so the
    // space must be part of the artifact and is dropped; an uppercase one
    // ("the ¨Uber…") is a real word boundary.
    const isLowercase = letter !== letter.toUpperCase();
    return isLowercase ? before.trimEnd() + composed : before + composed;
  });
}
