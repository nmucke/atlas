// Retrieval IDs belong in structured evidence, not in the readable review.
// Also handles older reviews that put multiple chunk IDs in one citation.
export function readableReview(body: string): string {
  return body
    .replace(/[ \t]*\[(?:[a-f0-9]{64})(?:\s*[,;]\s*[a-f0-9]{64})*\]/gi, '')
    .replace(/ +([.,;:!?])/g, '$1');
}

// Compatibility for reviews saved by servers predating structured reading scores.
// Require one explicitly labeled score and its rationale; never guess from other ratings.
export function legacyReadingRecommendation(
  body: string,
): { score: number; reason: string } | null {
  const lines = readableReview(body).split(/\r?\n/);
  const labeled = lines.filter((line) => /^\s*Reading recommendation:/i.test(line));
  if (labeled.length !== 1) return null;
  const match = labeled[0].match(
    /^\s*Reading recommendation:\s*([1-5])\s*\/\s*5\s*(?:\([^\n)]*\))?\s*[.:-]\s*(\S.*)$/i,
  );
  if (!match) return null;
  return { score: Number(match[1]), reason: match[2].trim() };
}
