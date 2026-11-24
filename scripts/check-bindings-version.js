#!/usr/bin/env node
/**
 * Asserts the installed @tevalabs/xelma-bindings version matches the version
 * pinned in bindings.pin.json.
 *
 * Reads the package metadata npm actually installed
 * (node_modules/@tevalabs/xelma-bindings/package.json), not the vendored source
 * or a build artifact, so a stale or partial install is caught. Exits non-zero
 * when the version differs or cannot be determined.
 */

const fs = require("fs");
const path = require("path");

const PIN_FILE = "bindings.pin.json";
const PACKAGE_SEGMENTS = ["node_modules", "@tevalabs", "xelma-bindings", "package.json"];

function fail(message) {
  process.stderr.write(`[check-bindings-version] FAILED — ${message}\n`);
  process.exit(1);
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} not found at ${filePath}. Run \`npm ci\` before this check.`);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} at ${filePath} is not valid JSON: ${error.message}`);
  }
}

function main(cwd = process.cwd()) {
  const pinPath = path.join(cwd, PIN_FILE);
  const pin = readJson(pinPath, "Bindings pin");

  const expectedVersion = pin.packageVersion;
  if (typeof expectedVersion !== "string" || expectedVersion.trim() === "") {
    fail(`${PIN_FILE} must declare a non-empty "packageVersion".`);
  }

  const installedPath = path.join(cwd, ...PACKAGE_SEGMENTS);
  const installed = readJson(installedPath, "Installed bindings package metadata");

  if (installed.name !== pin.packageName) {
    fail(
      `installed package is ${JSON.stringify(installed.name)}, expected ${pin.packageName} ` +
        `(${installedPath}).`,
    );
  }

  const installedVersion = installed.version;
  if (typeof installedVersion !== "string" || installedVersion.trim() === "") {
    fail(`installed package has no version in ${installedPath}.`);
  }

  if (installedVersion !== expectedVersion) {
    fail(
      `installed @tevalabs/xelma-bindings version is ${installedVersion}, but ${PIN_FILE} ` +
        `expects ${expectedVersion}. Run \`npm ci\` to reinstall the vendored bindings.`,
    );
  }

  process.stdout.write(
    `[check-bindings-version] OK — @tevalabs/xelma-bindings ${installedVersion} matches ${PIN_FILE}.\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { main };
