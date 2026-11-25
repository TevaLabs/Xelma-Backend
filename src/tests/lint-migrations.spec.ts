import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "lint-migrations.js");

interface MigrationFinding {
  file: string;
  line: number;
  rule: string;
  message: string;
  snippet: string;
}

// Plain Node script outside src/, so it is required rather than imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { lintMigrationSql, lintMigrationsDir } = require(SCRIPT) as {
  lintMigrationSql: (sql: string, filePath?: string) => MigrationFinding[];
  lintMigrationsDir: (migrationsDir?: string) => {
    filesChecked: number;
    findings: MigrationFinding[];
  };
};

describe("migration lint for destructive SQL", () => {
  describe("lintMigrationSql", () => {
    it("allows safe additive migrations and foreign key ON DELETE clauses", () => {
      const sql = `
        CREATE TABLE "Example" (
          "id" TEXT NOT NULL,
          "userId" TEXT NOT NULL,
          CONSTRAINT "Example_pkey" PRIMARY KEY ("id")
        );
        ALTER TABLE "Example" ADD COLUMN "notes" TEXT;
        ALTER TABLE "Example" ADD CONSTRAINT "Example_userId_fkey"
          FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        CREATE INDEX "Example_userId_idx" ON "Example"("userId");
      `;

      expect(lintMigrationSql(sql, "safe/migration.sql")).toEqual([]);
    });

    it("flags DROP TABLE statements", () => {
      const sql = `
        CREATE TABLE "Temp" ("id" TEXT);
        DROP TABLE "Temp";
      `;

      const findings = lintMigrationSql(sql, "drop-table/migration.sql");
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        file: "drop-table/migration.sql",
        line: 3,
        rule: "DROP_TABLE",
      });
    });

    it("flags DROP COLUMN statements case-insensitively", () => {
      const sql = `alter table "User" drop column "legacyField";`;

      const findings = lintMigrationSql(sql, "drop-col/migration.sql");
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        line: 1,
        rule: "DROP_COLUMN",
      });
    });

    it("flags DROP SCHEMA, DROP DATABASE, and TRUNCATE statements", () => {
      const sql = `
        DROP SCHEMA "old_schema";
        DROP DATABASE "old_db";
        TRUNCATE TABLE "AuditLog";
      `;

      const findings = lintMigrationSql(sql, "multi/migration.sql");
      expect(findings.map((f) => f.rule)).toEqual([
        "DROP_SCHEMA",
        "DROP_DATABASE",
        "TRUNCATE",
      ]);
    });

    it("flags unconditional DELETE FROM but allows DELETE FROM with WHERE", () => {
      const sql = `
        DELETE FROM "Session" WHERE "expiresAt" < NOW();
        DELETE FROM "Session";
      `;

      const findings = lintMigrationSql(sql, "delete/migration.sql");
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        line: 3,
        rule: "DELETE_WITHOUT_WHERE",
      });
    });

    it("ignores destructive keywords inside SQL comments and string literals", () => {
      const sql = `
        -- DROP TABLE "User";
        /*
         * TRUNCATE TABLE "Prediction";
         * ALTER TABLE "User" DROP COLUMN "email";
         */
        INSERT INTO "AuditLog" ("message") VALUES ('DROP TABLE "User"; TRUNCATE "Bet"');
      `;

      expect(lintMigrationSql(sql, "comments/migration.sql")).toEqual([]);
    });

    it("supports explicit opt-in via -- migration-lint:allow-destructive", () => {
      const sql = `
        -- migration-lint:allow-destructive
        DROP TABLE "LegacyTemp";
      `;

      expect(lintMigrationSql(sql, "allowed/migration.sql")).toEqual([]);
    });

    it("supports file-level opt-in via -- migration-lint:allow-destructive-file", () => {
      const sql = `
        -- migration-lint:allow-destructive-file
        DROP TABLE "LegacyA";
        TRUNCATE TABLE "LegacyB";
      `;

      expect(lintMigrationSql(sql, "allowed-file/migration.sql")).toEqual([]);
    });
  });

  describe("lintMigrationsDir & CLI", () => {
    it("passes on the repository prisma/migrations directory", () => {
      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Migration lint passed:/);
    });

    it("exits non-zero when a migration directory contains destructive SQL", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xelma-mig-lint-"));
      try {
        const migDir = path.join(tmpDir, "20261125000000_drop_users");
        fs.mkdirSync(migDir, { recursive: true });
        fs.writeFileSync(
          path.join(migDir, "migration.sql"),
          'DROP TABLE "User";\n',
          "utf8",
        );

        const dirResult = lintMigrationsDir(tmpDir);
        expect(dirResult.filesChecked).toBe(1);
        expect(dirResult.findings).toHaveLength(1);
        expect(dirResult.findings[0].rule).toBe("DROP_TABLE");

        const cliResult = spawnSync(process.execPath, [SCRIPT, tmpDir], {
          cwd: ROOT,
          encoding: "utf8",
        });
        expect(cliResult.status).toBe(1);
        expect(cliResult.stderr).toMatch(/DROP_TABLE/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
