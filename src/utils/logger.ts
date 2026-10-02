import winston from 'winston';
import { redactLogInfo } from './log-redaction';

// Central redaction helpers live in ./log-redaction.ts (imported from there
// by call sites that are exercised under a mocked logger) and are re-exported
// here so this module is the canonical entry point for redacting log metadata.
export { redact, redactField, redactWallet, REDACTED } from './log-redaction';

// Augment winston.Logger type to include our custom method
declare global {
  namespace Express {
    interface Logger {
      withRequestId(requestId?: string): winston.Logger;
    }
  }
}

/**
 * Central redaction format: every log entry (message + metadata) is passed
 * through the redactor before it reaches any transport. Authorization
 * headers, JWTs, env-like secrets (JWT_SECRET, ...) and full wallet addresses
 * never reach shared logs — even from call sites that log raw values.
 */
const redactFormat = winston.format((info) => redactLogInfo(info));

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    redactFormat(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

/**
 * Create a child logger with request ID context.
 * Adds requestId to all log entries for that context.
 */
(logger as any).withRequestId = function (requestId?: string): winston.Logger {
  if (!requestId) return this;
  
  return this.child({ requestId });
};

export default logger;
