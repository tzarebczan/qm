/**
 * Normalize outbound Buzz text so fancy punctuation does not render as "???"
 * in clients that mishandle some Unicode (common with em dashes / arrows).
 */
export function sanitizeBuzzOutbound(text: string): string {
  return (
    text
      // dashes / minus variants → ASCII hyphen or plain dash
      .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
      // arrows
      .replace(/[\u2190-\u2193\u21D0-\u21D3\u27F5-\u27FA]/g, "->")
      .replace(/\u2192/g, "->")
      .replace(/\u2190/g, "<-")
      // bullets / middle dots
      .replace(/[\u2022\u2023\u2043\u2219\u25E6\u00B7]/g, "-")
      // ellipsis
      .replace(/\u2026/g, "...")
      // smart quotes
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // non-breaking / odd spaces
      .replace(/[\u00A0\u202F\u2007]/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      // replacement char already present
      .replace(/\uFFFD/g, "?")
  );
}
