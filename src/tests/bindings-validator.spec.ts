/**
 * Regression coverage for #191 — vendored @tevalabs/xelma-bindings
 * integrity check that runs at startup. The check must distinguish
 * "completely missing", "partial install", "wrong package name", and
 * "fully present" so operators get an actionable warning before the
 * Soroban service throws an opaque module-resolution error.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

import { validateVendoredBindings } from "../utils/bindings-validator";

let cwdRoot = "";

function makeVendor(
  layout: {
    esm?: boolean;
    cjs?: boolean;
    pkg?: { name?: string } | null;
    commitSha?: string;
  } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xelma-vendor-"));
  const vendor = path.join(root, "vendor", "xelma-bindings");
  fs.mkdirSync(path.join(vendor, "dist", "cjs"), { recursive: true });

  if (layout.esm) {
    fs.writeFileSync(path.join(vendor, "dist", "index.js"), "// esm");
  }
  if (layout.cjs) {
    fs.writeFileSync(path.join(vendor, "dist", "cjs", "index.js"), "// cjs");
  }
  if (layout.pkg !== null) {
    const pkg = layout.pkg ?? { name: "@tevalabs/xelma-bindings" };
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

describe("validateVendoredBindings", () => {
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
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("vendor/xelma-bindings missing");
    expect(result.info.commitSha).toBeNull();
  });

  it("reports missing ESM entry when only CJS is present", () => {
    cwdRoot = makeVendor({ esm: false, cjs: true });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ESM entry missing"))).toBe(true);
  });

  it("reports missing CJS entry when only ESM is present", () => {
    cwdRoot = makeVendor({ esm: true, cjs: false });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("CJS entry missing"))).toBe(true);
  });

  it("reports wrong package name", () => {
    cwdRoot = makeVendor({ esm: true, cjs: true, pkg: { name: "wrong-name" } });
    const result = validateVendoredBindings(cwdRoot);
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
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.info.packageName).toBe("@tevalabs/xelma-bindings");
    expect(result.info.commitSha).toBe("abc123def456");
  });

  it("treats a missing .commit-sha as non-fatal (commitSha null)", () => {
    cwdRoot = makeVendor({ esm: true, cjs: true });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(true);
    expect(result.info.commitSha).toBeNull();
  });
});
