export class ConfigValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(
      [
        "Configuration validation failed:",
        ...errors.map((e) => `  - ${e}`),
        "",
        "Create or update .env from .env.example, then restart the server.",
      ].join("\n"),
    );
    this.name = "ConfigValidationError";
  }
}

class ConfigValidator {
  private errors: string[] = [];

  nonNegativeInt(
    value: string | undefined,
    name: string,
    fallback: number,
    opts?: { min?: number; max?: number },
  ): number {
    const raw = value?.trim();
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 0) {
      this.errors.push(`${name} must be a non-negative integer, got "${raw}"`);
      return fallback;
    }
    if (opts?.min !== undefined && parsed < opts.min) {
      this.errors.push(`${name} must be >= ${opts.min}, got "${raw}"`);
      return fallback;
    }
    if (opts?.max !== undefined && parsed > opts.max) {
      this.errors.push(`${name} must be <= ${opts.max}, got "${raw}"`);
      return fallback;
    }
    return parsed;
  }

  required(value: string | undefined, name: string): string {
    if (!value || value.trim().length === 0) {
      this.errors.push(
        `${name} is required but not set. Add ${name}=... to .env or your deployment environment.`,
      );
      return "";
    }
    return value.trim();
  }

  optional(value: string | undefined, fallback: string): string {
    if (!value || value.trim().length === 0) return fallback;
    return value.trim();
  }

  port(value: string | undefined, name: string, fallback: number): number {
    const raw = value?.trim();
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      this.errors.push(
        `${name} must be a valid port number (1-65535), got "${raw}"`,
      );
      return fallback;
    }
    return parsed;
  }

  positiveInt(
    value: string | undefined,
    name: string,
    fallback: number,
  ): number {
    const raw = value?.trim();
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed <= 0) {
      this.errors.push(`${name} must be a positive integer, got "${raw}"`);
      return fallback;
    }
    return parsed;
  }

  url(value: string | undefined, name: string, fallback?: string): string {
    const raw = value?.trim();
    if (!raw) {
      if (fallback !== undefined) return fallback;
      this.errors.push(
        `${name} is required but not set. Add ${name}=... to .env or your deployment environment.`,
      );
      return "";
    }
    try {
      new URL(raw);
    } catch {
      this.errors.push(`${name} must be a valid URL, got "${raw}"`);
    }
    return raw;
  }

  boolean(value: string | undefined, fallback: boolean): boolean {
    const raw = value?.trim()?.toLowerCase();
    if (!raw) return fallback;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    return fallback;
  }

  oneOf<T extends string>(
    value: string | undefined,
    name: string,
    allowed: readonly T[],
    fallback: T,
  ): T {
    const raw = value?.trim();
    if (!raw) return fallback;
    if (allowed.includes(raw as T)) return raw as T;
    this.errors.push(
      `${name} must be one of [${allowed.join(", ")}], got "${raw}"`,
    );
    return fallback;
  }

  sensitiveRequired(value: string | undefined, name: string): string {
    if (!value || value.trim().length === 0) {
      this.errors.push(
        `${name} is required and must not be empty. Generate a real secret and set ${name}=... in .env or your deployment environment.`,
      );
      return "";
    }
    const trimmed = value.trim();
    const placeholders = [
      "your-",
      "change-this",
      "CHANGE_ME",
      "replace-",
      "xxx",
      "TODO",
    ];
    for (const ph of placeholders) {
      if (trimmed.toLowerCase().includes(ph.toLowerCase())) {
        this.errors.push(
          `${name} appears to contain a placeholder value ("${ph}"). Set a real secret.`,
        );
        break;
      }
    }
    return trimmed;
  }

  throwIfErrors(): void {
    if (this.errors.length > 0) {
      throw new ConfigValidationError([...this.errors]);
    }
  }
}

export function createValidator(): ConfigValidator {
  return new ConfigValidator();
}
