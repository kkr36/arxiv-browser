export const KNOWN_PAPER_SOURCE_HINT =
  "NBER, NeurIPS/NIPS, and IEEE Xplore URLs are supported in addition to direct PDFs.";

export function resolveKnownPaperPdfUrl(raw: string): string | null {
  const url = safeUrl(raw.trim());
  if (!url || !/^https?:$/.test(url.protocol)) return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname;

  if (host === "nber.org") {
    const paperId =
      path.match(/^\/papers\/(w\d+)\/?$/i)?.[1] ??
      path.match(/^\/system\/files\/working_papers\/(w\d+)\/\1\.pdf$/i)?.[1];
    if (paperId) return `https://www.nber.org/system/files/working_papers/${paperId}/${paperId}.pdf`;
  }

  if (host === "conference.nber.org") {
    const paperId = path.match(/^\/conf_papers\/([^/]+?)(?:\.pdf)?\/?$/i)?.[1];
    if (paperId) return `https://conference.nber.org/conf_papers/${paperId}.pdf`;
  }

  if (host === "doi.org") {
    const nberPaperId = path.match(/^\/10\.3386\/(w\d+)\/?$/i)?.[1];
    if (nberPaperId) {
      return `https://www.nber.org/system/files/working_papers/${nberPaperId}/${nberPaperId}.pdf`;
    }
  }

  if (isNeuripsHost(host)) {
    const match = path.match(
      /^\/paper_files\/paper\/(\d{4})\/hash\/([a-f0-9]+)-Abstract(-[^/]+)?\.html$/i,
    );
    if (match) {
      const [, year, hash, suffix = ""] = match;
      return `${url.origin}/paper_files/paper/${year}/file/${hash}-Paper${suffix}.pdf`;
    }
  }

  if (host === "ieeexplore.ieee.org") {
    const arnumber =
      url.searchParams.get("arnumber") ??
      path.match(/^\/(?:abstract\/)?document\/(\d+)\/?$/i)?.[1];
    if (arnumber) return `https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${arnumber}`;
  }

  return null;
}

export function knownPaperUrlsFromText(rawText: string): string[] {
  const urls: string[] = [];

  for (const match of rawText.matchAll(/\bNBER\s+Working\s+Paper\s+(?:No\.\s*)?(\d{3,})\b/gi)) {
    urls.push(`https://www.nber.org/system/files/working_papers/w${match[1]}/w${match[1]}.pdf`);
  }

  for (const match of rawText.matchAll(/\b10\.3386\/(w\d+)\b/gi)) {
    const paperId = match[1].toLowerCase();
    urls.push(`https://www.nber.org/system/files/working_papers/${paperId}/${paperId}.pdf`);
  }

  for (const match of rawText.matchAll(/\bieeexplore\.ieee\.org\/document\/(\d+)\b/gi)) {
    urls.push(`https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${match[1]}`);
  }

  return unique(urls);
}

export function maybeKnownPaperUrl(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return (
    host === "nber.org" ||
    host === "conference.nber.org" ||
    isNeuripsHost(host) ||
    host === "ieeexplore.ieee.org" ||
    (host === "doi.org" &&
      (/^\/10\.3386\/w\d+\/?$/i.test(parsed.pathname) ||
        /^\/10\.1109\//i.test(parsed.pathname)))
  );
}

function isNeuripsHost(host: string): boolean {
  return (
    host === "papers.nips.cc" ||
    host === "papers.neurips.cc" ||
    host === "proceedings.neurips.cc" ||
    host === "datasets-benchmarks-proceedings.neurips.cc"
  );
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
