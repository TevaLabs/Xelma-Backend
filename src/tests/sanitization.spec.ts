import { 
  escapeHtml, 
  normalizeWhitespace, 
  isSuspiciousContent, 
  sanitizeChatContent, 
  validateContentLength 
} from '../utils/sanitization.util';

describe('Chat Content Sanitization', () => {
  describe('escapeHtml', () => {
    it('should escape HTML special characters', () => {
      expect(escapeHtml('<script>alert("xss")</script>'))
        .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;');
    });

    it('should escape ampersands', () => {
      expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    it('should escape quotes', () => {
      expect(escapeHtml('Say "hello"')).toBe('Say &quot;hello&quot;');
    });

    it('should escape single quotes', () => {
      expect(escapeHtml("It's fine")).toBe('It&#39;s fine');
    });

    it('should escape slashes', () => {
      expect(escapeHtml('example.com/path')).toBe('example.com&#x2F;path');
    });

    it('should handle empty strings', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('should not modify safe content', () => {
      expect(escapeHtml('Hello world 123!'))
        .toBe('Hello world 123!');
    });
  });

  describe('normalizeWhitespace', () => {
    it('should collapse multiple spaces', () => {
      expect(normalizeWhitespace('hello    world')).toBe('hello world');
    });

    it('should remove leading/trailing whitespace', () => {
      expect(normalizeWhitespace('  hello world  ')).toBe('hello world');
    });

    it('should handle tabs and newlines', () => {
      expect(normalizeWhitespace('hello\t\nworld')).toBe('hello world');
    });

    it('should remove zero-width spaces', () => {
      expect(normalizeWhitespace('hello\u200Bworld')).toBe('helloworld');
    });

    it('should handle multiple space types', () => {
      expect(normalizeWhitespace('hello   \t  world')).toBe('hello world');
    });
  });

  describe('isSuspiciousContent', () => {
    it('should detect excessive character repetition', () => {
      expect(isSuspiciousContent('aaaaaaa')).toBe(true);
      expect(isSuspiciousContent('hello11111')).toBe(true);
    });

    it('should not flag normal repetition', () => {
      expect(isSuspiciousContent('hello')).toBe(false);
      expect(isSuspiciousContent('see')).toBe(false);
    });

    it('should detect SQL injection patterns', () => {
      expect(isSuspiciousContent("admin' OR '1'='1")).toBe(true);
      expect(isSuspiciousContent('"; DROP TABLE users; --')).toBe(true);
      expect(isSuspiciousContent('UNION SELECT * FROM users')).toBe(true);
    });

    it('should detect command injection with shell keywords', () => {
      expect(isSuspiciousContent('test & bash -c "echo"')).toBe(true);
      expect(isSuspiciousContent('command | sh')).toBe(true);
    });

    it('should detect suspicious encoding patterns', () => {
      expect(isSuspiciousContent('%3Cscript%3E')).toBe(true);
      expect(isSuspiciousContent('\\x3cscript\\x3e')).toBe(true);
    });

    it('should detect extremely long words without spaces', () => {
      const longWord = 'a'.repeat(201);
      expect(isSuspiciousContent(longWord)).toBe(true);
    });

    it('should not flag normal messages', () => {
      expect(isSuspiciousContent('Hello, how are you?')).toBe(false);
      expect(isSuspiciousContent('This is a normal message')).toBe(false);
    });
  });

  describe('sanitizeChatContent', () => {
    it('should prevent XSS through HTML escaping', () => {
      const malicious = '<img src=x onerror="alert(\'xss\')">';
      const sanitized = sanitizeChatContent(malicious);
      expect(sanitized).not.toContain('<');
      expect(sanitized).not.toContain('>');
    });

    it('should reject content with SQL injection attempts', () => {
      expect(() => sanitizeChatContent("'; DROP TABLE users; --"))
        .toThrow('suspicious patterns');
    });

    it('should reject content with excessive repetition', () => {
      expect(() => sanitizeChatContent('aaaaaaa'))
        .toThrow('suspicious patterns');
    });

    it('should normalize whitespace before escaping', () => {
      const input = '  hello    world  ';
      const sanitized = sanitizeChatContent(input);
      expect(sanitized).toBe('hello world');
    });

    it('should handle normal messages without throwing', () => {
      const message = 'Hello, just saying hi!';
      const sanitized = sanitizeChatContent(message);
      expect(sanitized).toBe(message);
    });

    it('should throw on empty content', () => {
      expect(() => sanitizeChatContent('')).toThrow();
      expect(() => sanitizeChatContent('   ')).toThrow();
    });

    it('should throw on non-string content', () => {
      expect(() => sanitizeChatContent(null as any)).toThrow();
      expect(() => sanitizeChatContent(undefined as any)).toThrow();
      expect(() => sanitizeChatContent(123 as any)).toThrow();
    });
  });

  describe('validateContentLength', () => {
    it('should accept content within length limit', () => {
      expect(() => validateContentLength('hello', 500)).not.toThrow();
      expect(() => validateContentLength('a'.repeat(500), 500)).not.toThrow();
    });

    it('should reject empty content', () => {
      expect(() => validateContentLength('')).toThrow('empty');
    });

    it('should reject whitespace-only content', () => {
      expect(() => validateContentLength('   ')).toThrow();
    });

    it('should reject content exceeding max length', () => {
      expect(() => validateContentLength('a'.repeat(501), 500))
        .toThrow('exceeds maximum');
    });

    it('should use custom max length', () => {
      expect(() => validateContentLength('hello', 3))
        .toThrow('exceeds maximum');
    });

    it('should throw on non-string content', () => {
      expect(() => validateContentLength(null as any)).toThrow();
      expect(() => validateContentLength(undefined as any)).toThrow();
    });

    it('should provide error message with lengths', () => {
      const longContent = 'a'.repeat(501);
      try {
        validateContentLength(longContent, 500);
        fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('501');
        expect(error.message).toContain('500');
      }
    });
  });

  describe('XSS Prevention - Edge Cases', () => {
    it('should prevent attribute-based XSS', () => {
      const payload = '" onload="alert(\'xss\')" x="';
      const sanitized = sanitizeChatContent(payload);
      expect(sanitized).not.toContain('onload');
      expect(sanitized).toContain('&quot;');
    });

    it('should prevent data URI XSS', () => {
      const payload = '<a href="data:text/html,<script>alert(1)</script>">click</a>';
      const sanitized = sanitizeChatContent(payload);
      expect(sanitized).not.toContain('<');
    });

    it('should prevent JavaScript protocol XSS', () => {
      const payload = '<a href="javascript:alert(1)">click</a>';
      const sanitized = sanitizeChatContent(payload);
      expect(sanitized).not.toContain('<');
    });

    it('should handle Unicode escapes in payloads', () => {
      const payload = '\\u003cscript\\u003ealert(1)\\u003c/script\\u003e';
      const sanitized = sanitizeChatContent(payload);
      // Should detect the hex encoding pattern
      expect(isSuspiciousContent(payload)).toBe(true);
    });
  });

  describe('Injection Prevention - Edge Cases', () => {
    it('should detect case-insensitive SQL keywords', () => {
      expect(isSuspiciousContent('sElEcT * FROM users')).toBe(true);
      expect(isSuspiciousContent('InSeRt INTO table')).toBe(true);
    });

    it('should allow normal use of keywords in context', () => {
      // Note: These should NOT be flagged without SQL syntax
      expect(isSuspiciousContent('I selected option 3')).toBe(false);
      expect(isSuspiciousContent('Let me insert a thought')).toBe(false);
    });

    it('should reject stored procedure calls', () => {
      expect(isSuspiciousContent('EXEC xp_cmdshell "whoami"')).toBe(true);
      expect(isSuspiciousContent('sp_executesql')).toBe(true);
    });
  });
});
