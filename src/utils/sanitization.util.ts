/**
 * Content sanitization utilities for chat and user-generated content
 * Protects against XSS, injection attacks, and content policy violations
 */

/**
 * HTML entity map for escaping
 */
const HTML_ENTITY_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
};

/**
 * Escape HTML special characters to prevent XSS attacks
 * Converts <, >, &, quotes, and slashes to HTML entities
 * 
 * @example
 * escapeHtml('<script>alert("xss")</script>')
 * // Returns: '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;'
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'\/]/g, (char) => HTML_ENTITY_MAP[char] || char);
}

/**
 * Normalize whitespace and control characters
 * - Removes zero-width characters and other invisible Unicode
 * - Collapses multiple consecutive spaces
 * - Removes leading/trailing whitespace
 * 
 * @example
 * normalizeWhitespace('hello    world\u200B')  // zero-width space
 * // Returns: 'hello world'
 */
export function normalizeWhitespace(text: string): string {
  // Remove zero-width characters, control characters, and other invisible Unicode
  let normalized = text.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '');

  // Replace multiple consecutive spaces/tabs with single space
  normalized = normalized.replace(/[\s]+/g, ' ');

  // Remove leading and trailing whitespace
  normalized = normalized.trim();

  return normalized;
}

/**
 * Check if content contains suspicious patterns that indicate spam or abuse
 * 
 * Detects:
 * - Excessive repeated characters
 * - Suspicious URL patterns
 * - Command injection patterns
 * - SQL injection patterns
 * - Extremely long lines (potential payload)
 * 
 * @returns true if content is suspicious, false otherwise
 */
export function isSuspiciousContent(content: string): boolean {
  // Check for excessive repetition (5+ identical chars in a row)
  if (/(.)\1{4,}/i.test(content)) {
    return true;
  }

  // Check for SQL injection patterns
  if (
    /(?:--|\/\*|\*\/|;)/.test(content) ||
    /\b(or|and)\b\s+['"]?\w+['"]?\s*=\s*['"]?\w+/i.test(content) ||
    /\b(union\s+select|select\s+.+\s+from|drop\s+table|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(content) ||
    /\b(exec(?:ute)?\s+|xp_cmdshell|sp_executesql)\b/i.test(content)
  ) {
    return true;
  }

  // Check for command injection patterns
  if (/[&|`$(){}[\];\\<>]/.test(content) && /(\bsh\b|\bbash\b|\bcmd\b)/i.test(content)) {
    return true;
  }

  // Check for suspicious encoding patterns
  if (/(%[0-9A-Fa-f]{2}|\\x[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4})/i.test(content)) {
    return true;
  }

  // Check for excessively long lines (>200 chars without spaces - potential payload)
  const words = content.split(/\s+/);
  if (words.some(word => word.length > 200)) {
    return true;
  }

  return false;
}

/**
 * Sanitize chat message content
 * 
 * Applies:
 * 1. Whitespace normalization
 * 2. HTML escaping for XSS prevention
 * 3. Suspicious content detection
 * 
 * @throws Error if content fails moderation checks
 * @returns Sanitized content safe for storage and display
 */
export function sanitizeChatContent(content: string): string {
  if (!content || typeof content !== 'string') {
    throw new Error('Content must be a non-empty string');
  }

  // Normalize whitespace first
  let sanitized = normalizeWhitespace(content);

  if (sanitized.length === 0) {
    throw new Error('Content cannot be empty or whitespace-only');
  }

  sanitized = sanitized.replace(/\s+on\w+\s*=\s*(".*?"|'.*?'|[^\s>]*)/gi, '');

  // Check for suspicious patterns
  const containsOnlyEncodedText = /^(\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|%[0-9A-Fa-f]{2}|[A-Za-z0-9()\\/\s.])+$/i.test(sanitized);
  const hasExcessiveRepetition = /(.)\1{4,}/i.test(sanitized);
  if (isSuspiciousContent(sanitized) && (!containsOnlyEncodedText || hasExcessiveRepetition)) {
    throw new Error('Content contains suspicious patterns or potential injection attempts');
  }

  // Escape HTML entities for XSS prevention
  sanitized = escapeHtml(sanitized);

  return sanitized;
}

/**
 * Validate content length against constraints
 * 
 * @throws Error if content is too long or invalid
 */
export function validateContentLength(content: string, maxLength: number = 500): void {
  if (!content || typeof content !== 'string') {
    throw new Error('Content must be a non-empty string');
  }

  if (content.trim().length === 0) {
    throw new Error('Content cannot be empty or whitespace-only');
  }

  if (content.length > maxLength) {
    throw new Error(`Content exceeds maximum length of ${maxLength} characters (received ${content.length})`);
  }
}
