import { describe, expect, it } from '@jest/globals';
import rawTipCatalog from '../data/education-tips.json';
import { parseTipCatalog } from '../schemas/education-tip.schema';

const validTip = {
  id: 'price-action-001',
  category: 'price-action',
  message: 'The price moved {priceChangePercent}% in this round.',
  priority: 100,
};

describe('education tip catalog (src/data/education-tips.json)', () => {
  it('passes schema validation', () => {
    expect(() => parseTipCatalog(rawTipCatalog)).not.toThrow();
  });

  it('keeps the tip IDs and their order stable', () => {
    expect(parseTipCatalog(rawTipCatalog).map((tip) => tip.id)).toEqual([
      'price-action-001',
      'price-action-002',
      'price-action-003',
      'price-action-004',
      'volatility-001',
      'volatility-002',
      'volatility-003',
      'volatility-004',
      'volatility-005',
      'oracle-001',
      'oracle-002',
      'oracle-003',
      'oracle-004',
      'stellar-001',
      'stellar-002',
      'stellar-003',
      'stellar-004',
      'stellar-005',
    ]);
  });

  it('keeps the eligibility conditions of the original in-code library', () => {
    const conditions = Object.fromEntries(
      parseTipCatalog(rawTipCatalog)
        .filter((tip) => tip.condition)
        .map((tip) => [tip.id, tip.condition]),
    );

    expect(conditions).toEqual({
      'price-action-004': { type: 'absPriceChangePercent', lt: 0.5 },
      'volatility-001': { type: 'highVolatility' },
      'volatility-002': { type: 'absPriceChangePercent', gt: 2 },
      'volatility-003': { type: 'absPriceChangePercent', lt: 0.5 },
      'volatility-004': { type: 'absPriceChangePercent', gt: 1 },
      'volatility-005': { type: 'absPriceChangePercent', gt: 5 },
      'oracle-004': { type: 'absPriceChangePercent', gt: 1 },
    });
  });
});

describe('parseTipCatalog rejects invalid content', () => {
  it('accepts a minimal valid catalog', () => {
    expect(parseTipCatalog([validTip])).toEqual([validTip]);
  });

  it.each([
    ['a non-array document', { tips: [validTip] }, /\(root\)/],
    ['an empty catalog', [], /at least one tip/],
    ['a tip without a message', [{ ...validTip, message: undefined }], /0\.message/],
    ['an empty message', [{ ...validTip, message: '' }], /0\.message: Tip message is required/],
    ['an unknown category', [{ ...validTip, category: 'memes' }], /0\.category/],
    ['a non-numeric priority', [{ ...validTip, priority: 'high' }], /0\.priority/],
    ['an unknown field', [{ ...validTip, title: 'Nope' }], /title/],
    [
      'an unknown condition type',
      [{ ...validTip, condition: { type: 'fullMoon' } }],
      /0\.condition/,
    ],
    [
      'a threshold condition with no bounds',
      [{ ...validTip, condition: { type: 'absPriceChangePercent' } }],
      /at least one of `gt` or `lt`/,
    ],
    [
      'duplicate tip ids',
      [validTip, { ...validTip }],
      /1\.id: Duplicate tip id "price-action-001"/,
    ],
  ])('%s', (_label, raw, problem) => {
    expect(() => parseTipCatalog(raw)).toThrow(/Invalid education tip catalog/);
    expect(() => parseTipCatalog(raw)).toThrow(problem);
  });
});
