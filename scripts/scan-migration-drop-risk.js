#!/usr/bin/env node
/**
 * Migration safety scanner (#DROP risk).
 *
 * Scans Prisma migration files (`prisma/migrations/** /migration.sql`)
 * for dangerous DROP operations (such as `DROP TABLE`, `DROP COLUMN`,
 * `DROP DATABASE`, `DROP SCHEMA`) that risk irreversible data loss in production.
 *
 * Exits with status 1 if any unapproved DROP statements are detected.
 * To allow an intentional drop, an inline directive comment can be placed:
 *   -- allow-drop: <reason>
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "prisma", "migrations");

/**
 * Strips comments from SQL source, except lines containing allow-drop directives.
 */
function scanSqlContent(sqlContent) {
  const lines = sqlContent.split(/\r?\n/);
  const issues = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Check for inline allow-drop override directive
    if (/--\s*allow-drop/i.test(trimmed)) {
      continue;
    }

    // Handle block comments /* ... */
    if (inBlockComment) {
      if (trimmed.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) {
        inBlockComment = true;
      }
      continue;
    }

    // Single-line SQL comment
    if (trimmed.startsWith("--")) {
      continue;
    }

    // Pattern to catch DROP operations that present data loss risk:
    // DROP TABLE, DROP COLUMN, DROP DATABASE, DROP SCHEMA
    // e.g., "ALTER TABLE ... DROP COLUMN ...", "DROP TABLE ..."
    const dropMatch = trimmed.match(
      /\bDROP\s+(TABLE|COLUMN|DATABASE|SCHEMA)\b/i
    );

    if (dropMatch) {
      issues.push({
        line: i + 1,
        operation: dropMatch[0].toUpperCase(),
        statement: trimmed,
      });
    }
  }

  return issues;
}

/**
 * Finds all migration directories containing migration.sql
 */
function findMigrationFiles(migrationsRoot = MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsRoot)) {
    return [];
  }

  const entries = fs.readdirSync(migrationsRoot, { withFileTypes: true });
  const migrationFiles = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sqlPath = path.join(migrationsRoot, entry.name, "migration.sql");
      if (fs.existsSync(sqlPath)) {
        migrationFiles.push({
          dirName: entry.name,
          filePath: sqlPath,
        });
      }
    }
  }

  return migrationFiles;
}

/**
 * Scans all migrations in the project for DROP risks.
 */
function scanAllMigrations(migrationsRoot = MIGRATIONS_DIR) {
  const files = findMigrationFiles(migrationsRoot);
  const results = [];

  for (const file of files) {
    const content = fs.readFileSync(file.filePath, "utf8");
    const issues = scanSqlContent(content);
    if (issues.length > 0) {
      results.push({
        dirName: file.dirName,
        filePath: file.filePath,
        issues,
      });
    }
  }

  return results;
}

function main() {
  console.log("Scanning Prisma migrations for DROP risk...");
  const findings = scanAllMigrations();

  if (findings.length === 0) {
    console.log("✔ No DROP risks detected in migration.sql files.");
    process.exit(0);
  }

  console.error("✖ DROP risk detected in database migrations:");
  for (const finding of findings) {
    console.error(`\n  File: prisma/migrations/${finding.dirName}/migration.sql`);
    for (const issue of finding.issues) {
      console.error(
        `    Line ${issue.line}: [${issue.operation}] ${issue.statement}`
      );
    }
  }

  console.error("\nDropping tables or columns can lead to irreversible production data loss.");
  console.error("If this DROP is intentional and verified safe, add `-- allow-drop: <reason>` on the line.");
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  scanSqlContent,
  findMigrationFiles,
  scanAllMigrations,
};
