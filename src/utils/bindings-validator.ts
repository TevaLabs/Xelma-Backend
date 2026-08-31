import fs from "fs";
import path from "path";

/**
 * Vendored-bindings skew detection.
 *
 * `vendor/xelma-bindings` is generated from the Soroban contract in
 * Xelma-Blockchain and checked into this repo. When it drifts from the
 * contract that `src/services/soroban.service.ts` was written against, the
 * failure shows up as an opaque runtime error on a money path — usually
 * mid-campaign. This module turns that into a deterministic check that runs
 * in CI (`npm run check:bindings:abi`) and at startup (`src/index.ts`).
 *
 * Three independent layers are asserted against `bindings.pin.json`:
 *   1. Revision  — vendor/.commit-sha equals the pinned commitSha, and every
 *                  required build artifact exists.
 *   2. Type      — dist/index.d.ts exports the required types and declares
 *                  every required `Client` method with the expected argument
 *                  names. (`tsc` covers most of this, but only for code paths
 *                  that are actually type-checked and not `any`-cast.)
 *   3. ABI       — the Soroban contract spec embedded in dist/index.js as
 *                  base64 XDR declares each required function with those same
 *                  arguments. This is the only layer that sees the real
 *                  on-chain interface rather than generated TypeScript, so it
 *                  catches a stale/partial rebuild that still type-checks.
 */

export const BINDINGS_PACKAGE_NAME = "@tevalabs/xelma-bindings";
export const BINDINGS_PIN_FILE = "bindings.pin.json";

/** Steps an operator runs when this check fails. Logged verbatim on failure. */
export const BINDINGS_REMEDIATION = [
  "1. Rebuild the vendored bindings:  node scripts/install-bindings.js --refresh",
  "2. Re-run the checks:              npm run check:bindings && npm run build && npm run check:bindings:abi",
  "3. If the contract interface really changed, update bindings.pin.json " +
    "(commitSha + requiredMethods/requiredTypeExports) and src/services/soroban.service.ts together.",
  "See docs/bindings-upgrade.md for the full upgrade procedure.",
];

export interface BindingsPin {
  repository: string;
  ref: string;
  commitSha: string;
  packageName: string;
  requiredArtifacts: string[];
  requiredValueExports: string[];
  requiredTypeExports: string[];
  requiredEnumMembers: Record<string, string[]>;
  requiredTypeFields: Record<string, string[]>;
  /** method name -> argument names the backend passes */
  requiredMethods: Record<string, string[]>;
}

export interface BindingsValidationResult {
  ok: boolean;
  errors: string[];
  /** Non-fatal observations (e.g. a check that could not be performed). */
  warnings: string[];
  remediation: string[];
  info: {
    vendorPath: string;
    pinPath: string;
    esmEntry: string | null;
    cjsEntry: string | null;
    typesEntry: string | null;
    packageName: string | null;
    /** SHA recorded in vendor/xelma-bindings/.commit-sha */
    commitSha: string | null;
    /** SHA demanded by bindings.pin.json */
    expectedCommitSha: string | null;
    /** Client methods found in dist/index.d.ts */
    declaredMethods: string[];
    /** Client methods found in the compiled dist/index.js runtime surface */
    runtimeMethods: string[];
    /** Contract functions decoded from the embedded Soroban spec */
    specMethods: string[];
  };
}

/** Startup enforcement level. */
export type BindingsPolicy = "off" | "warn" | "strict";

export function getVendorBindingsRoot(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "vendor", "xelma-bindings");
}

export function getBindingsPinPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, BINDINGS_PIN_FILE);
}

const REQUIRED_PIN_KEYS: Array<keyof BindingsPin> = [
  "repository",
  "ref",
  "commitSha",
  "packageName",
  "requiredArtifacts",
  "requiredMethods",
];

/**
 * Read and shape-check bindings.pin.json. Throws when the pin itself is
 * unusable — an invalid pin is a repo bug, not a vendor-drift condition.
 */
export function loadBindingsPin(cwd: string = process.cwd()): BindingsPin {
  const pinPath = getBindingsPinPath(cwd);
  if (!fs.existsSync(pinPath)) {
    throw new Error(
      `Missing ${BINDINGS_PIN_FILE} at ${pinPath}. It records the expected ` +
        "@tevalabs/xelma-bindings commit and contract surface.",
    );
  }

  let parsed: Partial<BindingsPin>;
  try {
    parsed = JSON.parse(fs.readFileSync(pinPath, "utf8"));
  } catch (e) {
    throw new Error(`${BINDINGS_PIN_FILE} is not valid JSON: ${(e as Error).message}`);
  }

  for (const key of REQUIRED_PIN_KEYS) {
    if (parsed[key] === undefined) {
      throw new Error(`${BINDINGS_PIN_FILE} is missing required key "${key}".`);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(String(parsed.commitSha))) {
    throw new Error(
      `${BINDINGS_PIN_FILE} commitSha must be a 40-character hex SHA, got ${JSON.stringify(parsed.commitSha)}.`,
    );
  }

  return {
    repository: parsed.repository!,
    ref: parsed.ref!,
    commitSha: parsed.commitSha!,
    packageName: parsed.packageName ?? BINDINGS_PACKAGE_NAME,
    requiredArtifacts: parsed.requiredArtifacts ?? [],
    requiredValueExports: parsed.requiredValueExports ?? [],
    requiredTypeExports: parsed.requiredTypeExports ?? [],
    requiredEnumMembers: parsed.requiredEnumMembers ?? {},
    requiredTypeFields: parsed.requiredTypeFields ?? {},
    requiredMethods: parsed.requiredMethods ?? {},
  };
}

function readIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Extract the body of `export interface Client { ... }` from dist/index.d.ts
 * by brace matching, so nested object literals in method signatures do not
 * terminate the block early.
 */
function extractClientInterface(dts: string): string | null {
  const match = /export\s+interface\s+Client\s*\{/.exec(dts);
  if (!match) return null;

  let depth = 0;
  const start = match.index + match[0].length - 1;
  for (let i = start; i < dts.length; i++) {
    if (dts[i] === "{") depth++;
    else if (dts[i] === "}") {
      depth--;
      if (depth === 0) return dts.slice(start + 1, i);
    }
  }
  return null;
}

/**
 * Map each `Client` method to its declared signature. Generated members look
 * like `place_bet: ({ user, amount, side }: { ... }, options?) => Promise<...>`,
 * so the signature is captured by matching parentheses from the parameter list.
 */
function parseDeclaredMethods(clientBody: string): Map<string, string> {
  const methods = new Map<string, string>();
  const memberStart = /(?:^|[;}\n])\s*([a-z_][a-z0-9_]*)\s*:\s*\(/gi;

  for (const match of clientBody.matchAll(memberStart)) {
    const name = match[1];
    const parenStart = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = parenStart; i < clientBody.length; i++) {
      if (clientBody[i] === "(") depth++;
      else if (clientBody[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    methods.set(name, clientBody.slice(parenStart, end + 1));
  }
  return methods;
}

/**
 * Method names on the compiled runtime surface. Generated clients expose every
 * contract function as a key of the `fromJSON` map, in both the ESM and CJS
 * builds, so a partial rebuild shows up as a missing key here.
 */
function parseRuntimeMethods(js: string): string[] {
  const block = /fromJSON\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(js);
  if (!block) return [];
  return Array.from(block[1].matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gim)).map((m) => m[1]);
}

/**
 * Decode the base64 XDR contract-spec entries embedded in the generated
 * client. Each entry is a stream of XDR strings (4-byte big-endian length
 * followed by the bytes), so a function or argument name is present iff its
 * exact length prefix + bytes appear — which is why this does not false-match
 * on doc comments that merely mention the name.
 */
function decodeSpecEntries(js: string): string[] {
  const candidates = Array.from(js.matchAll(/"([A-Za-z0-9+/]{40,}={0,2})"/g)).map((m) => m[1]);
  return candidates.map((b64) => Buffer.from(b64, "base64").toString("latin1"));
}

function specContainsToken(entry: string, token: string): boolean {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(token.length, 0);
  return entry.includes(prefix.toString("latin1") + token);
}

/**
 * Verify the vendored @tevalabs/xelma-bindings package matches
 * bindings.pin.json — revision, build artifacts, TypeScript surface and the
 * embedded Soroban contract ABI.
 *
 * Returns a structured result rather than throwing; callers decide whether a
 * mismatch is fatal (see {@link resolveBindingsPolicy}).
 */
export function validateVendoredBindings(
  cwd: string = process.cwd(),
): BindingsValidationResult {
  const vendorPath = getVendorBindingsRoot(cwd);
  const pinPath = getBindingsPinPath(cwd);
  const esmEntryPath = path.join(vendorPath, "dist", "index.js");
  const cjsEntryPath = path.join(vendorPath, "dist", "cjs", "index.js");
  const typesEntryPath = path.join(vendorPath, "dist", "index.d.ts");
  const packageJsonPath = path.join(vendorPath, "package.json");
  const commitShaPath = path.join(vendorPath, ".commit-sha");

  const errors: string[] = [];
  const warnings: string[] = [];
  let packageName: string | null = null;
  let commitSha: string | null = null;
  let expectedCommitSha: string | null = null;
  let declaredMethods: string[] = [];
  let runtimeMethods: string[] = [];
  let specMethods: string[] = [];

  const finish = (): BindingsValidationResult => ({
    ok: errors.length === 0,
    errors,
    warnings,
    remediation: BINDINGS_REMEDIATION,
    info: {
      vendorPath,
      pinPath,
      esmEntry: fs.existsSync(esmEntryPath) ? esmEntryPath : null,
      cjsEntry: fs.existsSync(cjsEntryPath) ? cjsEntryPath : null,
      typesEntry: fs.existsSync(typesEntryPath) ? typesEntryPath : null,
      packageName,
      commitSha,
      expectedCommitSha,
      declaredMethods,
      runtimeMethods,
      specMethods,
    },
  });

  let pin: BindingsPin;
  try {
    pin = loadBindingsPin(cwd);
    expectedCommitSha = pin.commitSha;
  } catch (e) {
    errors.push((e as Error).message);
    return finish();
  }

  if (!fs.existsSync(vendorPath)) {
    errors.push(
      `vendor/xelma-bindings missing at ${vendorPath}. ` +
        "Run `node scripts/install-bindings.js --refresh` to fetch and build the bindings.",
    );
    return finish();
  }

  // ── Layer 1: revision + build artifacts ────────────────────────────────
  if (!fs.existsSync(esmEntryPath)) errors.push(`ESM entry missing: ${esmEntryPath}`);
  if (!fs.existsSync(cjsEntryPath)) errors.push(`CJS entry missing: ${cjsEntryPath}`);

  for (const artifact of pin.requiredArtifacts) {
    const artifactPath = path.join(vendorPath, artifact);
    if (!fs.existsSync(artifactPath)) {
      errors.push(`Required binding artifact missing: vendor/xelma-bindings/${artifact}`);
    }
  }

  const pkgRaw = readIfPresent(packageJsonPath);
  if (pkgRaw === null) {
    errors.push(`package.json missing: ${packageJsonPath}`);
  } else {
    try {
      const pkg = JSON.parse(pkgRaw);
      packageName = typeof pkg?.name === "string" ? pkg.name : null;
      if (packageName !== pin.packageName) {
        errors.push(
          `vendor package.json name is ${JSON.stringify(packageName)}, expected ${pin.packageName}`,
        );
      }
    } catch (e) {
      errors.push(`vendor package.json is not valid JSON: ${(e as Error).message}`);
    }
  }

  const shaRaw = readIfPresent(commitShaPath);
  commitSha = shaRaw ? shaRaw.trim() || null : null;
  if (!commitSha) {
    errors.push(
      `vendor/xelma-bindings/.commit-sha is missing or empty; cannot prove the vendored ` +
        `bindings were built from ${pin.commitSha}.`,
    );
  } else if (commitSha !== pin.commitSha) {
    errors.push(
      `Bindings commit skew: vendor/xelma-bindings/.commit-sha is ${commitSha}, ` +
        `but ${BINDINGS_PIN_FILE} pins ${pin.commitSha}.`,
    );
  }

  // ── Layer 2: TypeScript surface ────────────────────────────────────────
  const dts = readIfPresent(typesEntryPath);
  if (dts === null) {
    errors.push(`Type declarations missing: ${typesEntryPath}`);
  } else {
    for (const name of pin.requiredValueExports) {
      const declared = new RegExp(
        `export\\s+declare\\s+(?:class|const|enum|function)\\s+${name}\\b`,
      ).test(dts);
      if (!declared) {
        errors.push(`Bindings no longer export the value \`${name}\` (dist/index.d.ts).`);
      }
    }

    for (const name of pin.requiredTypeExports) {
      const declared = new RegExp(
        `export\\s+(?:declare\\s+)?(?:interface|type|enum|class)\\s+${name}\\b`,
      ).test(dts);
      if (!declared) {
        errors.push(`Bindings no longer export the type \`${name}\` (dist/index.d.ts).`);
      }
    }

    for (const [enumName, members] of Object.entries(pin.requiredEnumMembers)) {
      const block = new RegExp(
        `export\\s+declare\\s+enum\\s+${enumName}\\s*\\{([^}]*)\\}`,
      ).exec(dts);
      if (!block) {
        errors.push(`Bindings no longer declare enum \`${enumName}\`.`);
        continue;
      }
      for (const member of members) {
        if (!new RegExp(`\\b${member}\\s*=`).test(block[1])) {
          errors.push(`Enum \`${enumName}\` is missing member \`${member}\`.`);
        }
      }
    }

    for (const [typeName, fields] of Object.entries(pin.requiredTypeFields)) {
      const block = new RegExp(
        `export\\s+interface\\s+${typeName}\\s*\\{([^}]*)\\}`,
      ).exec(dts);
      if (!block) {
        errors.push(`Bindings no longer declare interface \`${typeName}\`.`);
        continue;
      }
      for (const field of fields) {
        if (!new RegExp(`\\b${field}\\s*[?]?\\s*:`).test(block[1])) {
          errors.push(`Interface \`${typeName}\` is missing field \`${field}\`.`);
        }
      }
    }

    const clientBody = extractClientInterface(dts);
    if (clientBody === null) {
      errors.push("Could not locate `export interface Client` in dist/index.d.ts.");
    } else {
      const signatures = parseDeclaredMethods(clientBody);
      declaredMethods = Array.from(signatures.keys()).sort();
      for (const [method, args] of Object.entries(pin.requiredMethods)) {
        const signature = signatures.get(method);
        if (!signature) {
          errors.push(
            `Contract method \`${method}\` is missing from the bindings Client interface ` +
              "but is called by src/services/soroban.service.ts.",
          );
          continue;
        }
        for (const arg of args) {
          // Match the property declaration in the parameter type literal
          // (`{ user: string; amount: i128 }`), not a passing mention in a
          // destructuring pattern or a nested generic.
          if (!new RegExp(`\\b${arg}\\s*[?]?\\s*:`).test(signature)) {
            errors.push(
              `Contract method \`${method}\` no longer accepts argument \`${arg}\` ` +
                "(signature changed upstream).",
            );
          }
        }
      }
    }
  }

  // ── Layer 2b: compiled runtime surface (ESM + CJS) ─────────────────────
  const esmSource = readIfPresent(esmEntryPath);
  const cjsSource = readIfPresent(cjsEntryPath);
  for (const [label, source] of [
    ["ESM", esmSource],
    ["CJS", cjsSource],
  ] as const) {
    if (source === null) continue;
    const methods = parseRuntimeMethods(source);
    if (label === "ESM") runtimeMethods = [...methods].sort();
    if (methods.length === 0) {
      warnings.push(
        `Could not read the ${label} runtime method map from the built bindings; ` +
          "skipped the runtime surface check for that build.",
      );
      continue;
    }
    for (const method of Object.keys(pin.requiredMethods)) {
      if (!methods.includes(method)) {
        errors.push(
          `Contract method \`${method}\` is absent from the ${label} build of the ` +
            "vendored bindings (stale or partial build).",
        );
      }
    }
  }

  // ── Layer 3: embedded Soroban contract ABI ─────────────────────────────
  if (esmSource !== null) {
    const entries = decodeSpecEntries(esmSource);
    if (entries.length === 0) {
      warnings.push(
        "Could not locate the embedded contract spec in dist/index.js; " +
          "skipped the ABI-level check.",
      );
    } else {
      for (const [method, args] of Object.entries(pin.requiredMethods)) {
        const entry = entries.find((e) => specContainsToken(e, method));
        if (!entry) {
          errors.push(
            `Contract ABI mismatch: the vendored contract spec does not declare a ` +
              `\`${method}\` function.`,
          );
          continue;
        }
        specMethods.push(method);
        for (const arg of args) {
          if (!specContainsToken(entry, arg)) {
            errors.push(
              `Contract ABI mismatch: \`${method}\` in the vendored contract spec has no ` +
                `\`${arg}\` argument.`,
            );
          }
        }
      }
      specMethods = specMethods.sort();
    }
  }

  return finish();
}

/**
 * Startup enforcement level.
 *
 * `BINDINGS_CHECK` (off|warn|strict) always wins. Otherwise the check is
 * strict exactly when a broken vendor would take down real money paths —
 * a production boot with a contract configured and on-chain bets enabled, or
 * any deployment that has opted into fail-closed Soroban behaviour. Every
 * other environment (local dev, tests, API-only deployments that never touch
 * Soroban) only warns, so a missing vendor never blocks them.
 */
export function resolveBindingsPolicy(
  env: NodeJS.ProcessEnv = process.env,
): BindingsPolicy {
  const explicit = env.BINDINGS_CHECK?.trim().toLowerCase();
  if (explicit === "off" || explicit === "warn" || explicit === "strict") {
    return explicit;
  }

  const hasContract = Boolean(env.SOROBAN_CONTRACT_ID || env.CONTRACT_ID);
  const stubMode = env.BET_STUB_MODE === "true";

  if (env.SOROBAN_FAIL_CLOSED === "true" && hasContract) return "strict";
  if (env.NODE_ENV === "production" && hasContract && !stubMode) return "strict";
  return "warn";
}

/** Human-readable multi-line report; used by the CLI and by startup logs. */
export function formatBindingsReport(result: BindingsValidationResult): string {
  const lines = [
    `vendor:   ${result.info.vendorPath}`,
    `pin:      ${result.info.pinPath}`,
    `expected: ${result.info.expectedCommitSha ?? "(unknown)"}`,
    `vendored: ${result.info.commitSha ?? "(unknown)"}`,
  ];
  if (result.warnings.length) {
    lines.push("", "Warnings:", ...result.warnings.map((w) => `  ! ${w}`));
  }
  if (result.errors.length) {
    lines.push("", "Errors:", ...result.errors.map((e) => `  ✗ ${e}`));
    lines.push("", "Remediation:", ...result.remediation.map((r) => `  ${r}`));
  }
  return lines.join("\n");
}
