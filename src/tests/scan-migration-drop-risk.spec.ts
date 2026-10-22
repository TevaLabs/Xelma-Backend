import { describe, expect, it } from "@jest/globals";
import path from "path";
import { spawnSync } from "child_process";
import fs from "fs";

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "scan-migration-drop-risk.js");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scanSqlContent, findMigrationFiles, scanAllMigrations } = require(SCRIPT) as {
  scanSqlContent: (sql: string) => Array<{ line: number; operation: string; statement: string }>;
  findMigrationFiles: (dir?: string) => Array<{ dirName: string; filePath: string }>;
  scanAllMigrations: (dir?: string) => Array<{ dirName: string; filePath: string; issues: any[] }>;
};

describe("scan-migration-drop-risk", () => {
  describe("scanSqlContent", () => {
    it("detects DROP TABLE statements", () => {
      const sql = `
        CREATE TABLE "User" ("id" TEXT PRIMARY KEY);
        DROP TABLE "User";
      `;
      const issues = scanSqlContent(sql);
      expect(issues.length).toBe(1);
      expect(issues[0].operation).toBe("DROP TABLE");
      expect(issues[0].line).toBe(3);
    });

    it("detects ALTER TABLE ... DROP COLUMN statements", () => {
      const sql = `
        ALTER TABLE "User" DROP COLUMN "email";
      `;
      const issues = scanSqlContent(sql);
      expect(issues.length).toBe(1);
      expect(issues[0].operation).toBe("DROP COLUMN");
      expect(issues[0].line).toBe(2);
    });

    it("detects DROP SCHEMA and DROP DATABASE statements", () => {
      const sql = `
        DROP SCHEMA IF EXISTS "public";
        DROP DATABASE "test";
      `;
      const issues = scanSqlContent(sql);
      expect(issues.length).toBe(2);
      expect(issues[0].operation).toBe("DROP SCHEMA");
      expect(issues[1].operation).toBe("DROP DATABASE");
    });

    it("ignores comments and non-destructive statements", () => {
      const sql = `
        -- DROP TABLE "Ignored";
        /*
          DROP COLUMN "legacy";
        */
        CREATE TABLE "Safe" ("id" SERIAL PRIMARY KEY);
        ALTER TABLE "Safe" ADD COLUMN "name" TEXT;
      `;
      const issues = scanSqlContent(sql);
      expect(issues.length).toBe(0);
    });

    it("allows intentional drops with -- allow-drop directive", () => {
      const sql = `
        DROP TABLE "DeprecatedTable"; -- allow-drop: decommissioned in v2
        ALTER TABLE "User" DROP COLUMN "old_field"; -- allow-drop: data migrated
      `;
      const issues = scanSqlContent(sql);
      expect(issues.length).toBe(0);
    });
  });

  describe("repository migration files", () => {
    it("finds migration files and confirms zero DROP risks in committed migrations", () => {
      const files = findMigrationFiles();
      expect(files.length).toBeGreaterThan(0);

      const findings = scanAllMigrations();
      expect(findings).toEqual([]);
    });
  });

  describe("CLI execution", () => {
    it("exits with 0 when repository migrations have no DROP risk", () => {
      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("No DROP risks detected in migration.sql files.");
    });
  });
});
