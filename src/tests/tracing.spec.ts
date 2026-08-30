import { traceSpan, traceSubSpan, getCurrentSpan, SpanAttributes } from '../utils/tracing';

describe('Tracing – lightweight OTel-style spans (#534)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('traceSpan', () => {
    it('executes fn and returns its result', async () => {
      process.env.TRACE_ENABLED = 'true';
      process.env.TRACE_EXPORT = 'none';

      const result = await traceSpan('test.op', { requestId: 'req-1' }, async (span) => {
        expect(span.name).toBe('test.op');
        expect(span.requestId).toBe('req-1');
        expect(span.spanId).toBeTruthy();
        return 42;
      });

      expect(result).toBe(42);
    });

    it('sets and reads attributes on the span', async () => {
      process.env.TRACE_ENABLED = 'true';
      process.env.TRACE_EXPORT = 'none';

      await traceSpan('test.attr', {}, async (span) => {
        span.setAttribute('key1', 'value1');
        span.setAttribute('key2', 123);
        span.setAttribute('key3', true);

        expect(span.attributes.key1).toBe('value1');
        expect(span.attributes.key2).toBe(123);
        expect(span.attributes.key3).toBe(true);
      });
    });

    it('records errors on the span', async () => {
      process.env.TRACE_ENABLED = 'true';
      process.env.TRACE_EXPORT = 'none';

      await traceSpan('test.error', {}, async (span) => {
        const err = new Error('test failure');
        span.recordError(err);

        expect(span.attributes['error.name']).toBe('Error');
        expect(span.attributes['error.message']).toBe('test failure');
      });
    });

    it('propagates errors thrown in fn', async () => {
      process.env.TRACE_ENABLED = 'true';
      process.env.TRACE_EXPORT = 'none';

      await expect(
        traceSpan('test.throw', {}, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('restores parent span after completion', async () => {
      process.env.TRACE_ENABLED = 'true';
      process.env.TRACE_EXPORT = 'none';

      expect(getCurrentSpan()).toBeNull();

      await traceSpan('outer', {}, async (outerSpan) => {
        expect(getCurrentSpan()?.spanId).toBe(outerSpan.spanId);

        await traceSubSpan('inner', {}, async (innerSpan) => {
          expect(getCurrentSpan()?.spanId).toBe(innerSpan.spanId);
          expect(innerSpan.parentSpanId).toBe(outerSpan.spanId);
        });

        expect(getCurrentSpan()?.spanId).toBe(outerSpan.spanId);
      });

      expect(getCurrentSpan()).toBeNull();
    });
  });

  describe('traceSubSpan', () => {
    it('creates a sub-span with parent correlation', async () => {
      process.env.TRACE_ENABLED = 'true';
      process.env.TRACE_EXPORT = 'none';

      await traceSpan('parent', { requestId: 'r-1' }, async (parentSpan) => {
        await traceSubSpan('child', { 'child.key': 'val' }, async (childSpan) => {
          expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
          expect(childSpan.requestId).toBe('r-1');
          expect(childSpan.attributes['child.key']).toBe('val');
        });
      });
    });
  });

  describe('disabled mode', () => {
    it('returns fn result without creating spans when TRACE_ENABLED=false', async () => {
      process.env.TRACE_ENABLED = 'false';

      const result = await traceSpan('noop', {}, async (span) => {
        expect(span.spanId).toBe('noop');
        return 'ok';
      });

      expect(result).toBe('ok');
    });
  });

  describe('getCurrentSpan', () => {
    it('returns null when no span is active', () => {
      expect(getCurrentSpan()).toBeNull();
    });

    it('returns the active span during traceSpan execution', async () => {
      process.env.TRACE_ENABLED = 'true';
      process.env.TRACE_EXPORT = 'none';

      expect(getCurrentSpan()).toBeNull();

      await traceSpan('test.current', {}, async (span) => {
        expect(getCurrentSpan()).toBe(span);
      });

      expect(getCurrentSpan()).toBeNull();
    });
  });
});
