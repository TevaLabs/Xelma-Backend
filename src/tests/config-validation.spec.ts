import { describe, it, expect } from '@jest/globals';
import { createValidator, ConfigValidationError } from '../config/validation';

describe('ConfigValidator.assert (#229 cross-field checks)', () => {
  it('records an error and throws when the condition is false', () => {
    const v = createValidator();
    v.assert(false, 'ORACLE_STALENESS_THRESHOLD_MS must be greater than ORACLE_POLLING_INTERVAL_MS');

    expect(() => v.throwIfErrors()).toThrow(ConfigValidationError);
    try {
      v.throwIfErrors();
    } catch (err) {
      expect((err as ConfigValidationError).errors).toContain(
        'ORACLE_STALENESS_THRESHOLD_MS must be greater than ORACLE_POLLING_INTERVAL_MS',
      );
    }
  });

  it('is a no-op when the condition is true', () => {
    const v = createValidator();
    v.assert(true, 'should not be recorded');

    expect(() => v.throwIfErrors()).not.toThrow();
  });

  it('accumulates assert errors alongside other field errors', () => {
    const v = createValidator();
    v.positiveInt('-5', 'SOME_FIELD', 1); // records a field error
    v.assert(false, 'cross-field failure');

    expect(() => v.throwIfErrors()).toThrow(ConfigValidationError);
    try {
      v.throwIfErrors();
    } catch (err) {
      expect((err as ConfigValidationError).errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});
