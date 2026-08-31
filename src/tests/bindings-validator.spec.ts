/**
 * Regression coverage for the vendored @tevalabs/xelma-bindings skew check.
 *
 * Originally #191 (is the vendor present at all?); extended to assert the
 * contract surface soroban.service.ts depends on. The check must distinguish
 * "completely missing", "partial install", "wrong package name", "pinned
 * commit drifted", "TypeScript surface drifted", "runtime build is stale" and
 * "the embedded contract ABI no longer declares the method" — the last of
 * which `tsc` cannot see.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

import {
  BINDINGS_PACKAGE_NAME,
  formatBindingsReport,
  loadBindingsPin,
  resolveBindingsPolicy,
  validateVendoredBindings,
} from "../utils/bindings-validator";

const PINNED_SHA = "a".repeat(40);

/** Minimal but realistic slice of the generated dist/index.d.ts. */
const DTS = `
export interface Round {
    bet_end_ledger: u32;
    end_ledger: u32;
    mode: RoundMode;
    pool_down: i128;
    pool_up: i128;
    price_start: u128;
    round_id: u64;
    start_ledger: u32;
}
export type BetSide = {
    tag: "Up";
    values: void;
} | {
    tag: "Down";
    values: void;
};
export declare enum RoundMode {
    UpDown = 0,
    Precision = 1
}
export interface UserStats {
    best_streak: u32;
    current_streak: u32;
    total_losses: u32;
    total_wins: u32;
}
export interface OraclePayload {
    price: u128;
    round_id: u32;
    timestamp: u64;
}
export interface Client {
    balance: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<i128>>;
    place_bet: ({ user, amount, side }: {
        user: string;
        amount: i128;
        side: BetSide;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    create_round: ({ start_price, mode }: {
        start_price: u128;
        mode: Option<u32>;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    mint_initial: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<i128>>;
    resolve_round: ({ payload }: {
        payload: OraclePayload;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    claim_winnings: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<i128>>;
    get_user_stats: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<UserStats>>;
    get_active_round: (options?: MethodOptions) => Promise<AssembledTransaction<Option<Round>>>;
    get_pending_winnings: ({ user }: {
        user: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<i128>>;
    place_precision_prediction: ({ user, amount, predicted_price }: {
        user: string;
        amount: i128;
        predicted_price: u128;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
}
export declare class Client extends ContractClient {
}
`;

const METHOD_ARGS: Record<string, string[]> = {
  create_round: ["start_price", "mode"],
  place_bet: ["user", "amount", "side"],
  place_precision_prediction: ["user", "amount", "predicted_price"],
  resolve_round: ["payload"],
  get_active_round: [],
  mint_initial: ["user"],
  balance: ["user"],
  get_user_stats: ["user"],
  get_pending_winnings: ["user"],
  claim_winnings: ["user"],
};

/** XDR-style length-prefixed string, as the real contract spec encodes names. */
function xdrString(value: string): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(value.length, 0);
  return Buffer.concat([prefix, Buffer.from(value, "latin1")]);
}

/** One base64 contract-spec entry per contract function, as generated clients embed. */
function specEntry(method: string, args: string[]): string {
  return Buffer.concat([
    xdrString(`Construct and simulate a ${method} transaction against the contract`),
    xdrString(method),
    ...args.map(xdrString),
  ]).toString("base64");
}

function buildEsm(methods: Record<string, string[]>): string {
  const entries = Object.entries(methods)
    .map(([m, args]) => `            "${specEntry(m, args)}"`)
    .join(",\n");
  const fromJSON = Object.keys(methods)
    .map((m) => `        ${m}: (this.txFromJSON)`)
    .join(",\n");
  return [
    "export class Client extends ContractClient {",
    "    constructor(options) {",
    "        super(new ContractSpec([",
    entries,
    "        ]), options);",
    "    }",
    "    fromJSON = {",
    fromJSON,
    "    };",
    "}",
  ].join("\n");
}

interface Layout {
  esm?: boolean;
  cjs?: boolean;
  types?: boolean;
  pkg?: { name?: string } | null;
  commitSha?: string | null;
  pin?: Record<string, unknown> | null;
  dts?: string;
  /** Overrides the method map used for the ESM/CJS runtime + spec surface. */
  methods?: Record<string, string[]>;
}

let cwdRoot = "";

function makeVendor(layout: Layout = {}): string {
  const {
    esm = true,
    cjs = true,
    types = true,
    pkg = { name: BINDINGS_PACKAGE_NAME },
    commitSha = PINNED_SHA,
    pin = {},
    dts = DTS,
    methods = METHOD_ARGS,
  } = layout;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xelma-vendor-"));
  const vendor = path.join(root, "vendor", "xelma-bindings");
  fs.mkdirSync(path.join(vendor, "dist", "cjs"), { recursive: true });

  if (pin !== null) {
    fs.writeFileSync(
      path.join(root, "bindings.pin.json"),
      JSON.stringify(
        {
          repository: "https://github.com/TevaLabs/Xelma-Blockchain.git",
          ref: "main",
          commitSha: PINNED_SHA,
          packageName: BINDINGS_PACKAGE_NAME,
          requiredArtifacts: ["package.json", "dist/index.js", "dist/index.d.ts", "dist/cjs/index.js"],
          requiredValueExports: ["Client", "RoundMode"],
          requiredTypeExports: ["Round", "BetSide", "OraclePayload", "UserStats"],
          requiredEnumMembers: { RoundMode: ["UpDown", "Precision"] },
          requiredTypeFields: {
            Round: ["round_id", "mode", "price_start", "pool_up", "pool_down"],
            OraclePayload: ["price", "round_id", "timestamp"],
          },
          requiredMethods: METHOD_ARGS,
          ...pin,
        },
        null,
        2,
      ),
    );
  }

  const esmSource = buildEsm(methods);
  if (esm) fs.writeFileSync(path.join(vendor, "dist", "index.js"), esmSource);
  if (cjs) fs.writeFileSync(path.join(vendor, "dist", "cjs", "index.js"), esmSource);
  if (types) fs.writeFileSync(path.join(vendor, "dist", "index.d.ts"), dts);
  if (pkg !== null) {
    fs.writeFileSync(path.join(vendor, "package.json"), JSON.stringify(pkg, null, 2));
  }
  if (commitSha !== null) {
    fs.writeFileSync(path.join(vendor, ".commit-sha"), `${commitSha}\n`);
  }
  return root;
}

function withoutMethod(method: string): Record<string, string[]> {
  const clone = { ...METHOD_ARGS };
  delete clone[method];
  return clone;
}

afterEach(() => {
  if (cwdRoot && fs.existsSync(cwdRoot)) {
    fs.rmSync(cwdRoot, { recursive: true, force: true });
  }
  cwdRoot = "";
});

describe("validateVendoredBindings — vendor integrity", () => {
  it("passes for a complete, correctly pinned vendor", () => {
    cwdRoot = makeVendor();
    const result = validateVendoredBindings(cwdRoot);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.info.packageName).toBe(BINDINGS_PACKAGE_NAME);
    expect(result.info.commitSha).toBe(PINNED_SHA);
    expect(result.info.expectedCommitSha).toBe(PINNED_SHA);
    expect(result.info.declaredMethods).toContain("place_bet");
    expect(result.info.runtimeMethods).toContain("place_bet");
    expect(result.info.specMethods).toContain("place_bet");
  });

  it("reports missing vendor directory entirely", () => {
    cwdRoot = makeVendor();
    fs.rmSync(path.join(cwdRoot, "vendor"), { recursive: true, force: true });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("vendor/xelma-bindings missing");
  });

  it("fails when bindings.pin.json is absent", () => {
    cwdRoot = makeVendor({ pin: null });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("bindings.pin.json");
  });

  it("reports missing ESM entry when only CJS is present", () => {
    cwdRoot = makeVendor({ esm: false });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ESM entry missing"))).toBe(true);
  });

  it("reports missing CJS entry when only ESM is present", () => {
    cwdRoot = makeVendor({ cjs: false });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("CJS entry missing"))).toBe(true);
  });

  it("reports wrong package name", () => {
    cwdRoot = makeVendor({ pkg: { name: "wrong-name" } });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(BINDINGS_PACKAGE_NAME))).toBe(true);
  });
});

describe("validateVendoredBindings — commit pin", () => {
  it("fails when the vendored SHA differs from the pinned SHA", () => {
    cwdRoot = makeVendor({ commitSha: "b".repeat(40) });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Bindings commit skew"))).toBe(true);
  });

  it("fails when .commit-sha is missing — the build cannot be attributed", () => {
    cwdRoot = makeVendor({ commitSha: null });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(".commit-sha"))).toBe(true);
    expect(result.info.commitSha).toBeNull();
  });

  it("rejects a malformed pin rather than silently passing", () => {
    cwdRoot = makeVendor({ pin: { commitSha: "not-a-sha" } });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("40-character hex SHA"))).toBe(true);
  });
});

describe("validateVendoredBindings — TypeScript surface", () => {
  it("fails when a required contract method disappears from the Client interface", () => {
    cwdRoot = makeVendor({
      dts: DTS.replace(/    claim_winnings: \(\{ user \}: \{\n        user: string;\n    \}[^;]*;\n/, ""),
    });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("claim_winnings") && e.includes("missing from the bindings Client"),
      ),
    ).toBe(true);
  });

  it("fails when a method loses an argument the backend passes", () => {
    cwdRoot = makeVendor({
      dts: DTS.replace("        side: BetSide;\n", ""),
    });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("place_bet") && e.includes("`side`")),
    ).toBe(true);
  });

  it("fails when a required type export is removed", () => {
    cwdRoot = makeVendor({ dts: DTS.replace("export interface OraclePayload", "interface OraclePayload") });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("`OraclePayload`"))).toBe(true);
  });

  it("fails when a required struct field is renamed", () => {
    cwdRoot = makeVendor({ dts: DTS.replace("price_start: u128;", "start_price: u128;") });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("`Round`") && e.includes("`price_start`")),
    ).toBe(true);
  });

  it("fails when a required enum member is removed", () => {
    cwdRoot = makeVendor({ dts: DTS.replace("    Precision = 1\n", "") });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("RoundMode") && e.includes("Precision")),
    ).toBe(true);
  });
});

describe("validateVendoredBindings — compiled + ABI surface", () => {
  it("fails when the built client is stale relative to its own declarations", () => {
    // The .d.ts still declares every method, but the compiled bundle does not
    // implement one of them — a partial rebuild that `tsc` cannot detect.
    cwdRoot = makeVendor({ methods: withoutMethod("get_pending_winnings") });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("get_pending_winnings") && e.includes("ESM build"),
      ),
    ).toBe(true);
  });

  it("fails when the embedded contract spec no longer declares a function", () => {
    cwdRoot = makeVendor();
    const esmPath = path.join(cwdRoot, "vendor", "xelma-bindings", "dist", "index.js");
    const renamed = buildEsm({
      ...withoutMethod("create_round"),
      create_round_v2: METHOD_ARGS.create_round,
    }).replace(/create_round_v2: \(this\.txFromJSON\)/, "create_round: (this.txFromJSON)");
    fs.writeFileSync(esmPath, renamed);
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("Contract ABI mismatch") && e.includes("create_round"),
      ),
    ).toBe(true);
  });

  it("fails when the contract spec drops an argument the backend passes", () => {
    cwdRoot = makeVendor({
      methods: { ...METHOD_ARGS, place_precision_prediction: ["user", "amount"] },
    });
    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("Contract ABI mismatch") && e.includes("`predicted_price` argument"),
      ),
    ).toBe(true);
  });

  it("warns rather than fails when no contract spec can be located", () => {
    cwdRoot = makeVendor();
    const vendor = path.join(cwdRoot, "vendor", "xelma-bindings");
    const stripped = Object.keys(METHOD_ARGS)
      .map((m) => `        ${m}: (this.txFromJSON)`)
      .join(",\n");
    const source = `export class Client {\n    fromJSON = {\n${stripped}\n    };\n}\n`;
    fs.writeFileSync(path.join(vendor, "dist", "index.js"), source);
    fs.writeFileSync(path.join(vendor, "dist", "cjs", "index.js"), source);

    const result = validateVendoredBindings(cwdRoot);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("contract spec"))).toBe(true);
  });
});

describe("formatBindingsReport", () => {
  it("includes the remediation steps whenever the check fails", () => {
    cwdRoot = makeVendor({ commitSha: "c".repeat(40) });
    const report = formatBindingsReport(validateVendoredBindings(cwdRoot));
    expect(report).toContain("Errors:");
    expect(report).toContain("Remediation:");
    expect(report).toContain("docs/bindings-upgrade.md");
  });
});

describe("loadBindingsPin", () => {
  it("reads the repo-level pin used by the installer and the validator", () => {
    const pin = loadBindingsPin(path.resolve(__dirname, "..", ".."));
    expect(pin.packageName).toBe(BINDINGS_PACKAGE_NAME);
    expect(pin.commitSha).toMatch(/^[0-9a-f]{40}$/);
    // The pin must cover every method soroban.service.ts calls.
    expect(Object.keys(pin.requiredMethods).sort()).toEqual(
      Object.keys(METHOD_ARGS).sort(),
    );
  });
});

describe("resolveBindingsPolicy", () => {
  it("honours an explicit BINDINGS_CHECK override", () => {
    expect(resolveBindingsPolicy({ BINDINGS_CHECK: "off" })).toBe("off");
    expect(resolveBindingsPolicy({ BINDINGS_CHECK: "STRICT" })).toBe("strict");
    expect(
      resolveBindingsPolicy({
        BINDINGS_CHECK: "warn",
        NODE_ENV: "production",
        SOROBAN_CONTRACT_ID: "C123",
      }),
    ).toBe("warn");
  });

  it("is strict in production when a contract is configured", () => {
    expect(
      resolveBindingsPolicy({ NODE_ENV: "production", SOROBAN_CONTRACT_ID: "C123" }),
    ).toBe("strict");
    expect(resolveBindingsPolicy({ NODE_ENV: "production", CONTRACT_ID: "C123" })).toBe(
      "strict",
    );
  });

  it("is strict for any fail-closed deployment with a contract", () => {
    expect(
      resolveBindingsPolicy({ SOROBAN_FAIL_CLOSED: "true", CONTRACT_ID: "C123" }),
    ).toBe("strict");
  });

  it("only warns for API-only, stubbed, and non-production deployments", () => {
    expect(resolveBindingsPolicy({ NODE_ENV: "production" })).toBe("warn");
    expect(
      resolveBindingsPolicy({
        NODE_ENV: "production",
        SOROBAN_CONTRACT_ID: "C123",
        BET_STUB_MODE: "true",
      }),
    ).toBe("warn");
    expect(
      resolveBindingsPolicy({ NODE_ENV: "development", SOROBAN_CONTRACT_ID: "C123" }),
    ).toBe("warn");
    expect(resolveBindingsPolicy({})).toBe("warn");
  });
});
