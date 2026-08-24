/**
 * Regression coverage for #191 and #499 — vendored @tevalabs/xelma-bindings
 * integrity check that runs at startup. The check must distinguish
 * "completely missing", "partial install", "wrong package name", "SHA
 * mismatch", "missing API surface", and "fully present" so operators get
 * an actionable warning before the Soroban service throws an opaque
 * module-resolution error.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

import {
  validateVendoredBindingsSync,
  validateVendoredBindings,
  loadBindingsMetadata,
  getVendorBindingsRoot,
  getMetadataPath,
} from "../utils/bindings-validator";

let cwdRoot = "";

function makeVendor(
  layout: {
    esm?: boolean;
    cjs?: boolean;
    pkg?: { name?: string } | null;
    commitSha?: string;
    esmExports?: Record<string, unknown>;
  } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xelma-vendor-"));
  const vendor = path.join(root, "vendor", "xelma-bindings");
  fs.mkdirSync(path.join(vendor, "dist", "cjs"), { recursive: true });

  if (layout.esm) {
    const exports = layout.esmExports ?? {};
    const exportLines = Object.entries(exports)
      .map(([name, val]) => `export const ${name} = ${JSON.stringify(val)};`)
      .join("\n");
    const clientMethods = [
      "balance",
      "get_admin",
      "place_bet",
      "get_oracle",
      "initialize",
      "set_windows",
      "create_round",
      "mint_initial",
      "predict_price",
      "resolve_round",
      "claim_winnings",
      "get_user_stats",
      "get_active_round",
      "get_last_round_id",
      "get_user_position",
      "get_pending_winnings",
      "get_updown_positions",
      "get_precision_predictions",
      "place_precision_prediction",
      "get_user_precision_prediction",
    ];
    const methodImpls = clientMethods
      .map((m) => `  ${m}() { return Promise.resolve({ result: null }); }`)
      .join("\n");
    const esmContent = [
      exportLines,
      "export class Client {",
      "  constructor(_opts) {}",
      methodImpls,
      "}",
      "export const BetSide = { Up: { tag: 'Up' }, Down: { tag: 'Down' } };",
      "export const RoundMode = { UpDown: 0, Precision: 1 };",
      "export const OraclePayload = {};",
      "export const UserStats = {};",
      "export const UserPosition = {};",
      "export const ContractError = {};",
    ].join("\n");
    fs.writeFileSync(path.join(vendor, "dist", "index.js"), esmContent);
  }
  if (layout.cjs) {
    fs.writeFileSync(path.join(vendor, "dist", "cjs", "index.js"), "// cjs");
  }
  if (layout.pkg !== null) {
    const pkg = layout.pkg ?? { name: "@tevalabs/xelma-bindings" };
    // Ensure type: module so dynamic import works for ESM files
    if (!pkg.type) {
      (pkg as any).type = "module";
    }
    fs.writeFileSync(
      path.join(vendor, "package.json"),
      JSON.stringify(pkg, null, 2),
    );
  }
  if (layout.commitSha) {
    fs.writeFileSync(path.join(vendor, ".commit-sha"), layout.commitSha);
  }
  return root;
}

function makeMetadata(
  root: string,
  meta: {
    expectedCommitSha?: string;
    requiredClientMethods?: string[];
    requiredExports?: string[];
  },
): void {
  fs.writeFileSync(
    path.join(root, ".bindings-metadata.json"),
    JSON.stringify(meta, null, 2),
  );
}

describe("validateVendoredBindingsSync", () => {
  beforeEach(() => {
    cwdRoot = "";
  });

  afterEach(() => {
    if (cwdRoot && fs.existsSync(cwdRoot)) {
      fs.rmSync(cwdRoot, { recursive: true, force: true });
    }
  });

  it("reports missing vendor directory entirely", () => {
    cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-vendor-"));
    const result = validateVendoredBindingsSync(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("vendor/xelma-bindings missing");
    expect(result.info.commitSha).toBeNull();
  });

  it("reports missing ESM entry when only CJS is present", () => {
    cwdRoot = makeVendor({ esm: false, cjs: true });
    const result = validateVendoredBindingsSync(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ESM entry missing"))).toBe(true);
  });

  it("reports missing CJS entry when only ESM is present", () => {
    cwdRoot = makeVendor({ esm: true, cjs: false });
    const result = validateVendoredBindingsSync(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("CJS entry missing"))).toBe(true);
  });

  it("reports wrong package name", () => {
    cwdRoot = makeVendor({ esm: true, cjs: true, pkg: { name: "wrong-name" } });
    const result = validateVendoredBindingsSync(cwdRoot);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("@tevalabs/xelma-bindings")),
    ).toBe(true);
  });

  it("returns ok=true when ESM + CJS + correct package.json present", () => {
    cwdRoot = makeVendor({
      esm: true,
      cjs: true,
      pkg: { name: "@tevalabs/xelma-bindings" },
      commitSha: "abc123def456\n",
    });
    const result = validateVendoredBindingsSync(cwdRoot);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.info.packageName).toBe("@tevalabs/xelma-bindings");
    expect(result.info.commitSha).toBe("abc123def456");
  });

  it("treats a missing .commit-sha as non-fatal (commitSha null)", () => {
    cwdRoot = makeVendor({ esm: true, cjs: true });
    const result = validateVendoredBindingsSync(cwdRoot);
    expect(result.ok).toBe(true);
    expect(result.info.commitSha).toBeNull();
  });

  it("detects SHA mismatch when metadata pins a specific SHA", () => {
    cwdRoot = makeVendor({
      esm: true,
      cjs: true,
      commitSha: "actual-sha-123\n",
    });
    makeMetadata(cwdRoot, { expectedCommitSha: "expected-sha-456" });
    const result = validateVendoredBindingsSync(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.info.shaMatch).toBe(false);
    expect(result.errors.some((e) => e.includes("does not match expected"))).toBe(true);
  });

  it("confirms SHA match when vendor SHA matches metadata", () => {
    cwdRoot = makeVendor({
      esm: true,
      cjs: true,
      commitSha: "expected-sha-456\n",
    });
    makeMetadata(cwdRoot, { expectedCommitSha: "expected-sha-456" });
    const result = validateVendoredBindingsSync(cwdRoot);
    expect(result.ok).toBe(true);
    expect(result.info.shaMatch).toBe(true);
  });

  it("reports missing .commit-sha when metadata pins a SHA", () => {
    cwdRoot = makeVendor({ esm: true, cjs: true });
    makeMetadata(cwdRoot, { expectedCommitSha: "expected-sha-456" });
    const result = validateVendoredBindingsSync(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.info.shaMatch).toBe(false);
    expect(result.errors.some((e) => e.includes(".commit-sha is missing"))).toBe(true);
  });

  it("skips SHA check when metadata SHA is PLACEHOLDER", () => {
    cwdRoot = makeVendor({
      esm: true,
      cjs: true,
      commitSha: "any-sha\n",
    });
    makeMetadata(cwdRoot, { expectedCommitSha: "PLACEHOLDER" });
    const result = validateVendoredBindingsSync(cwdRoot);
    expect(result.ok).toBe(true);
    expect(result.info.shaMatch).toBeNull();
  });
});

describe("validateVendoredBindings (async surface checks)", () => {
  beforeEach(() => {
    cwdRoot = "";
  });

  afterEach(() => {
    if (cwdRoot && fs.existsSync(cwdRoot)) {
      fs.rmSync(cwdRoot, { recursive: true, force: true });
    }
  });

  it("returns ok=true when all surface checks pass", async () => {
    cwdRoot = makeVendor({
      esm: true,
      cjs: true,
      commitSha: "abc123\n",
    });
    makeMetadata(cwdRoot, {
      expectedCommitSha: "abc123",
      requiredClientMethods: ["balance", "create_round"],
      requiredExports: ["Client", "BetSide"],
    });

    // Provide a mock module loader since Jest intercepts dynamic import()
    const mockLoader = async (_esmPath: string): Promise<Record<string, unknown>> => ({
      Client: class Client {
        constructor(_opts: unknown) {}
        balance() { return Promise.resolve({ result: null }); }
        get_admin() { return Promise.resolve({ result: null }); }
        place_bet() { return Promise.resolve({ result: null }); }
        get_oracle() { return Promise.resolve({ result: null }); }
        initialize() { return Promise.resolve({ result: null }); }
        set_windows() { return Promise.resolve({ result: null }); }
        create_round() { return Promise.resolve({ result: null }); }
        mint_initial() { return Promise.resolve({ result: null }); }
        predict_price() { return Promise.resolve({ result: null }); }
        resolve_round() { return Promise.resolve({ result: null }); }
        claim_winnings() { return Promise.resolve({ result: null }); }
        get_user_stats() { return Promise.resolve({ result: null }); }
        get_active_round() { return Promise.resolve({ result: null }); }
        get_last_round_id() { return Promise.resolve({ result: null }); }
        get_user_position() { return Promise.resolve({ result: null }); }
        get_pending_winnings() { return Promise.resolve({ result: null }); }
        get_updown_positions() { return Promise.resolve({ result: null }); }
        get_precision_predictions() { return Promise.resolve({ result: null }); }
        place_precision_prediction() { return Promise.resolve({ result: null }); }
        get_user_precision_prediction() { return Promise.resolve({ result: null }); }
      },
      BetSide: { Up: { tag: "Up" }, Down: { tag: "Down" } },
      RoundMode: { UpDown: 0, Precision: 1 },
    });

    const result = await validateVendoredBindings(cwdRoot, mockLoader);
    expect(result.ok).toBe(true);
    expect(result.info.missingMethods).toEqual([]);
    expect(result.info.missingExports).toEqual([]);
  });

  it("detects missing Client methods", async () => {
    cwdRoot = makeVendor({
      esm: true,
      cjs: true,
      commitSha: "abc123\n",
    });
    makeMetadata(cwdRoot, {
      expectedCommitSha: "abc123",
      requiredClientMethods: ["balance", "nonexistent_method"],
      requiredExports: [],
    });
    // Mock loader that provides Client with only the `balance` method
    const mockLoader = async (_esmPath: string): Promise<Record<string, unknown>> => ({
      Client: class Client {
        constructor(_opts: unknown) {}
        balance() { return Promise.resolve({ result: null }); }
      },
    });
    const result = await validateVendoredBindings(cwdRoot, mockLoader);
    expect(result.ok).toBe(false);
    expect(result.info.missingMethods).toContain("nonexistent_method");
    expect(result.errors.some((e) => e.includes("missing required methods"))).toBe(true);
  });

  it("detects missing module exports", async () => {
    cwdRoot = makeVendor({
      esm: true,
      cjs: true,
      commitSha: "abc123\n",
    });
    makeMetadata(cwdRoot, {
      expectedCommitSha: "abc123",
      requiredClientMethods: [],
      requiredExports: ["Client", "NonexistentExport"],
    });
    // Mock loader that provides only Client
    const mockLoader = async (_esmPath: string): Promise<Record<string, unknown>> => ({
      Client: class Client {},
    });
    const result = await validateVendoredBindings(cwdRoot, mockLoader);
    expect(result.ok).toBe(false);
    expect(result.info.missingExports).toContain("NonexistentExport");
    expect(result.errors.some((e) => e.includes("missing required exports"))).toBe(true);
  });

  it("skips surface checks when structural checks fail", async () => {
    cwdRoot = makeVendor({ esm: false, cjs: false });
    makeMetadata(cwdRoot, {
      expectedCommitSha: "abc123",
      requiredClientMethods: ["balance"],
      requiredExports: ["Client"],
    });
    const result = await validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    // Surface checks should not have run
    expect(result.info.missingMethods).toEqual([]);
    expect(result.info.missingExports).toEqual([]);
  });

  it("skips surface checks when metadata is absent", async () => {
    cwdRoot = makeVendor({ esm: true, cjs: true });
    const result = await validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(true);
    expect(result.info.missingMethods).toEqual([]);
    expect(result.info.missingExports).toEqual([]);
  });
});

describe("loadBindingsMetadata", () => {
  afterEach(() => {
    if (cwdRoot && fs.existsSync(cwdRoot)) {
      fs.rmSync(cwdRoot, { recursive: true, force: true });
    }
  });

  it("returns null when metadata file does not exist", () => {
    cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-meta-"));
    const result = loadBindingsMetadata(cwdRoot);
    expect(result).toBeNull();
  });

  it("parses valid metadata file", () => {
    cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "meta-"));
    makeMetadata(cwdRoot, {
      expectedCommitSha: "sha-123",
      requiredClientMethods: ["balance"],
      requiredExports: ["Client"],
    });
    const result = loadBindingsMetadata(cwdRoot);
    expect(result).toEqual({
      expectedCommitSha: "sha-123",
      requiredClientMethods: ["balance"],
      requiredExports: ["Client"],
    });
  });

  it("returns null for invalid JSON", () => {
    cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bad-meta-"));
    fs.writeFileSync(
      path.join(cwdRoot, ".bindings-metadata.json"),
      "not json {{{",
    );
    const result = loadBindingsMetadata(cwdRoot);
    expect(result).toBeNull();
  });
});

describe("helper functions", () => {
  it("getVendorBindingsRoot returns correct path", () => {
    const result = getVendorBindingsRoot("/some/project");
    expect(result).toBe(path.resolve("/some/project", "vendor", "xelma-bindings"));
  });

  it("getMetadataPath returns correct path", () => {
    const result = getMetadataPath("/some/project");
    expect(result).toBe(path.resolve("/some/project", ".bindings-metadata.json"));
  });
});
