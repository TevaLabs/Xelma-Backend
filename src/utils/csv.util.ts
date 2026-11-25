/**
 * Minimal RFC 4180 CSV helpers for streaming exports.
 */

const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Formats one CSV cell. Quotes values that contain a comma, quote or line
 * break (doubling embedded quotes). Text that a spreadsheet would run as a
 * formula (starts with `=`, `+`, `-`, `@`, tab or CR) is prefixed with `'`;
 * plain numbers are left alone so a leading minus sign still parses.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !NUMERIC.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV record, terminated with CRLF as RFC 4180 specifies. */
export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
