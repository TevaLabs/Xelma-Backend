#!/usr/bin/env node
"use strict";

/**
 * Migration lint for destructive SQL statements.
 *
 * Scans Prisma migration.sql files for destructive DDL/DML operations
 * (DROP TABLE, DROP COLUMN, DROP SCHEMA, DROP DATABASE, TRUNCATE, and
 * unconditional DELETE FROM) that risk irreversible data loss in production.
 *
 * Intentional destructive statements can be explicitly acknowledged with:
 *   -- migration-lint:allow-destructive
 * on the same line or the immediately preceding line, or at the file level with:
 *   -- migration-lint:allow-destructive-file
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_MIGRATIONS_DIR = path.resolve(
  __dirname,
  "..",
  "prisma",
  "migrations",
);

const ALLOW_LINE_DIRECTIVE = /--\s*migration-lint:allow-destructive\b/i;
const ALLOW_FILE_DIRECTIVE = /--\s*migration-lint:allow-destructive-file\b/i;

const DESTRUCTIVE_RULES = [
  {
    id: "DROP_TABLE",
    description: "DROP TABLE can permanently delete table data",
    match: (stmt) => /\bDROP\s+TABLE\b/i.test(stmt),
  },
  {
    id: "DROP_COLUMN",
    description: "DROP COLUMN can permanently delete column data",
    match: (stmt) => /\bDROP\s+COLUMN\b/i.test(stmt),
  },
  {
    id: "DROP_SCHEMA",
    description: "DROP SCHEMA can permanently delete all objects in a schema",
    match: (stmt) => /\bDROP\s+SCHEMA\b/i.test(stmt),
  },
  {
    id: "DROP_DATABASE",
    description: "DROP DATABASE can permanently delete an entire database",
    match: (stmt) => /\bDROP\s+DATABASE\b/i.test(stmt),
  },
  {
    id: "TRUNCATE",
    description: "TRUNCATE permanently removes all rows from a table",
    match: (stmt) => /\bTRUNCATE\b/i.test(stmt),
  },
  {
    id: "DELETE_WITHOUT_WHERE",
    description: "DELETE FROM without a WHERE clause deletes all rows",
    match: (stmt) =>
      /^\s*DELETE\s+FROM\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt),
  },
];

/**
 * Replace SQL comments (-- and /* ... *\/) and single-quoted string literals
 * with spaces while preserving newline characters so line numbers remain exact.
 *
 * @param {string} sql
 * @returns {string}
 */
function stripCommentsAndStrings(sql) {
  let out = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : "";

    // Single-line comment: -- ...
    if (ch === "-" && next === "-") {
      out += "  ";
      i += 2;
      while (i < len && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < len) {
        if (sql[i] === "*" && i + 1 < len && sql[i + 1] === "/") {
          out += "  ";
          i += 2;
          break;
        }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    // Single-quoted string literal: '...' (with '' escapes)
    if (ch === "'") {
      out += " ";
      i += 1;
      while (i < len) {
        if (sql[i] === "'") {
          if (i + 1 < len && sql[i + 1] === "'") {
            out += "  ";
            i += 2;
            continue;
          }
          out += " ";
          i += 1;
          break;
        }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Split cleaned SQL into statements with their 1-based starting line number.
 *
 * @param {string} cleanedSql
 * @returns {Array<{ text: string, line: number }>}
 */
function splitStatements(cleanedSql) {
  const statements = [];
  let startIdx = 0;

  for (let i = 0; i <= cleanedSql.length; i += 1) {
    if (i === cleanedSql.length || cleanedSql[i] === ";") {
      const raw = cleanedSql.slice(startIdx, i);
      const firstNonWs = raw.search(/\S/);
      if (firstNonWs !== -1) {
        const prefix = cleanedSql.slice(0, startIdx + firstNonWs);
        const line = prefix.split("\n").length;
        statements.push({ text: raw.trim(), line });
      }
      startIdx = i + 1;
    }
  }

  return statements;
}

/**
 * Check whether a finding on a given 1-based line is explicitly allowed by a
 * `-- migration-lint:allow-destructive` comment on the same line or the
 * immediately preceding non-empty line.
 *
 * @param {string[]} originalLines
 * @param {number} lineNumber
 * @returns {boolean}
 */
function hasAllowDirective(originalLines, lineNumber) {
  const idx = lineNumber - 1;
  if (idx >= 0 && idx < originalLines.length) {
    if (ALLOW_LINE_DIRECTIVE.test(originalLines[idx])) {
      return true;
    }
  }
  for (let prev = idx - 1; prev >= 0; prev -= 1) {
    const trimmed = originalLines[prev].trim();
    if (trimmed === "") {
      continue;
    }
    return ALLOW_LINE_DIRECTIVE.test(trimmed);
  }
  return false;
}

/**
 * Lint a single migration SQL string for destructive statements.
 *
 * @param {string} sql
 * @param {string} [filePath="migration.sql"]
 * @returns {Array<{ file: string, line: number, rule: string, message: string, snippet: string }>}
 */
function lintMigrationSql(sql, filePath = "migration.sql") {
  if (!sql || ALLOW_FILE_DIRECTIVE.test(sql)) {
    return [];
  }

  const originalLines = sql.split(/\r?\n/);
  const cleaned = stripCommentsAndStrings(sql);
  const statements = splitStatements(cleaned);
  const findings = [];

  for (const stmt of statements) {
    if (hasAllowDirective(originalLines, stmt.line)) {
      continue;
    }

    for (const rule of DESTRUCTIVE_RULES) {
      if (rule.match(stmt.text)) {
        const snippet = stmt.text.replace(/\s+/g, " ").slice(0, 120);
        findings.push({
          file: filePath,
          line: stmt.line,
          rule: rule.id,
          message: rule.description,
          snippet,
        });
      }
    }
  }

  return findings;
}

/**
 * Recursively find all migration.sql files under a directory, sorted
 * deterministically.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function findMigrationFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMigrationFiles(fullPath));
    } else if (entry.isFile() && entry.name === "migration.sql") {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Lint all migration.sql files in the given directory.
 *
 * @param {string} [migrationsDir=DEFAULT_MIGRATIONS_DIR]
 * @returns {{ filesChecked: number, findings: Array<{ file: string, line: number, rule: string, message: string, snippet: string }> }}
 */
function lintMigrationsDir(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const files = findMigrationFiles(migrationsDir);
  const findings = [];

  for (const file of files) {
    const sql = fs.readFileSync(file, "utf8");
    const relPath = path.relative(process.cwd(), file) || file;
    findings.push(...lintMigrationSql(sql, relPath));
  }

  return { filesChecked: files.length, findings };
}

function main(argv = process.argv.slice(2)) {
  const targetDir = argv[0] ? path.resolve(argv[0]) : DEFAULT_MIGRATIONS_DIR;
  const { filesChecked, findings } = lintMigrationsDir(targetDir);

  if (findings.length > 0) {
    console.error(
      `Migration lint failed: found ${findings.length} destructive SQL statement(s) across ${filesChecked} migration file(s):\n`,
    );
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line} [${f.rule}] ${f.message}`);
      console.error(`    ${f.snippet}`);
    }
    console.error(
      "\nIf a destructive operation is intentional, add `-- migration-lint:allow-destructive` on the preceding line.",
    );
    return 1;
  }

  console.log(
    `Migration lint passed: scanned ${filesChecked} migration.sql file(s), no destructive SQL found.`,
  );
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  DESTRUCTIVE_RULES,
  stripCommentsAndStrings,
  splitStatements,
  lintMigrationSql,
  findMigrationFiles,
  lintMigrationsDir,
  main,
};
