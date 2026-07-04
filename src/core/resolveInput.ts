const ARXIV_ID_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;
// Pre-2007 ids like "hep-th/9901001" or "cs.CL/0301012".
const ARXIV_OLD_ID_RE = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/;

/**
 * Turns whatever the user typed (a bare arXiv id, an abs/pdf URL, or some
 * other direct PDF URL) into a fetchable PDF URL.
 */
export function resolveInputToPdfUrl(raw: string): string {
  const input = raw.trim();

  if (ARXIV_ID_RE.test(input) || ARXIV_OLD_ID_RE.test(input)) {
    return `https://arxiv.org/pdf/${input}.pdf`;
  }

  try {
    const url = new URL(input);
    const arxivMatch = url.pathname.match(
      /\/(abs|pdf)\/([\w.\-/]+?)(\.pdf)?\/?$/,
    );
    if (url.hostname.includes("arxiv.org") && arxivMatch) {
      return `https://arxiv.org/pdf/${arxivMatch[2]}.pdf`;
    }
    return url.toString();
  } catch {
    throw new Error(
      "Enter an arXiv id (e.g. 1706.03762), an arXiv URL, or a direct PDF URL.",
    );
  }
}
