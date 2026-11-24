/**
 * Regression coverage for the CI guard that asserts the installed
 * @tevalabs/xelma-bindings version matches bindings.pin.json (issue #996).
 *
 * The script is exercised end-to-end in a temporary project root so the check
 * reads real package metadata instead of a mock.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.resolve(__dirname, "../../scripts/check-bindings-version.js");
const PACKAGE_NAME = "@tevalabs/xelma-bindings";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const roots: string[] = [];

function runScript(cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { cwd }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === "number" ? error.code : error ? -1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

interface Layout {
  pin?: Record<string, unknown> | null;
  installed?: Record<string, unknown> | null;
}

function makeRoot(layout: Layout = {}): string {
  const {
    pin = { packageName: PACKAGE_NAME, packageVersion: "0.0.0" },
    installed = { name: PACKAGE_NAME, version: "0.0.0" },
  } = layout;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xelma-bindings-version-"));
  roots.push(root);

  if (pin !== null) {
    fs.writeFileSync(path.join(root, "bindings.pin.json"), JSON.stringify(pin, null, 2));
  }

  if (installed !== null) {
    const packageDir = path.join(root, "node_modules", "@tevalabs", "xelma-bindings");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(installed, null, 2));
  }

  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("check-bindings-version", () => {
  it("passes when the installed version matches the pin", async () => {
    const result = await runScript(makeRoot());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("OK");
    expect(result.stdout).toContain(`${PACKAGE_NAME} 0.0.0`);
  });

  it("fails when the installed version differs from the pin", async () => {
    const result = await runScript(
      makeRoot({
        pin: { packageName: PACKAGE_NAME, packageVersion: "0.0.0" },
        installed: { name: PACKAGE_NAME, version: "1.2.3" },
      }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("version is 1.2.3");
    expect(result.stderr).toContain("expects 0.0.0");
  });

  it("fails when the pin does not declare an expected version", async () => {
    const result = await runScript(makeRoot({ pin: { packageName: PACKAGE_NAME } }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("packageVersion");
  });

  it("fails when the installed package metadata is missing", async () => {
    const result = await runScript(makeRoot({ installed: null }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
    expect(result.stderr).toContain("npm ci");
  });

  it("fails when the installed package has no version", async () => {
    const result = await runScript(
      makeRoot({ installed: { name: PACKAGE_NAME } }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has no version");
  });

  it("fails when the installed package has the wrong name", async () => {
    const result = await runScript(
      makeRoot({ installed: { name: "some-other-package", version: "0.0.0" } }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(PACKAGE_NAME);
  });

  it("fails when bindings.pin.json is missing", async () => {
    const result = await runScript(makeRoot({ pin: null }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("bindings.pin.json");
  });

  it("keeps the repository pin in sync with the vendored package version", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const pin = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "bindings.pin.json"), "utf8"),
    );
    const vendor = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "vendor", "xelma-bindings", "package.json"),
        "utf8",
      ),
    );

    expect(pin.packageName).toBe(PACKAGE_NAME);
    expect(pin.packageVersion).toBe(vendor.version);
  });
});
