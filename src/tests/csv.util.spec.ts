import { describe, expect, it } from '@jest/globals';
import { csvCell, csvRow } from '../utils/csv.util';

describe('csv.util', () => {
  it('leaves plain values unquoted and renders null/undefined as empty', () => {
    expect(csvCell('abc')).toBe('abc');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes cells with commas, quotes or line breaks and doubles quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"');
  });

  it('formats dates as ISO 8601', () => {
    expect(csvCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('neutralises spreadsheet formulas but keeps negative numbers intact', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('-0.50000000')).toBe('-0.50000000');
  });

  it('joins a record with commas and ends it with CRLF', () => {
    expect(csvRow(['a', 'b,c', null, 3])).toBe('a,"b,c",,3\r\n');
  });
});
