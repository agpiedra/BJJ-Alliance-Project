/**
 * The one shared CSV builder every director-analytics panel exports through
 * (`ExportCsvButton`, `./export-csv-button.tsx`, is the one shared download
 * trigger) — later tasks in this phase must reuse both rather than growing a
 * second copy per panel.
 *
 * Header row comes from the first row's own key order; every row is assumed
 * to share the same shape (the same contract every panel's row interface
 * already gives it, e.g. `ClassPopularityRow`). A value containing a comma,
 * double quote, or newline is wrapped in double quotes with any embedded
 * quote doubled, per RFC 4126's usual CSV quoting rule.
 *
 * An empty `rows` array produces an empty string — no header, since there is
 * no row to read column names from.
 */
export function toCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return "";

  const headers = Object.keys(rows[0]);
  const lines = [headers, ...rows.map((row) => headers.map((header) => row[header]))];

  return lines.map((line) => line.map(escapeCsvValue).join(",")).join("\r\n");
}

function escapeCsvValue(value: string | number): string {
  const stringValue = String(value);
  if (/[",\r\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}
