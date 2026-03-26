#!/usr/bin/env node
/**
 * Fetches and builds @tevalabs/xelma-bindings from the Xelma-Blockchain Git repo.
 *
 * npm does not support installing from a Git subdirectory natively, so this
 * script performs a sparse checkout of the bindings/ folder, builds both an
 * ESM and a CommonJS output, then writes the result to vendor/xelma-bindings/.
 * package.json declares the dependency as "file:vendor/xelma-bindings".
 *
 * Run manually:   npm run install-bindings
 * Run on install: triggered automatically via the "preinstall" npm lifecycle.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const REPO_URL = "https://github.com/TevaLabs/Xelma-Blockchain.git";
const BRANCH = "main";
const SUBDIR = "bindings";
const DEST = path.resolve(__dirname, "..", "vendor", "xelma-bindings");

/** tsconfig override for CJS build */
const CJS_TSCONFIG = {
  extends: "./tsconfig.json",
  compilerOptions: {
    module: "Node16",
    moduleResolution: "node16",
    outDir: "./dist/cjs",
  },
};

function run(cmd, cwd) {
  execSync(cmd, { stdio: "inherit", cwd: cwd || process.cwd() });
}

function main() {
  // Skip if already built
  if (
    fs.existsSync(path.join(DEST, "dist", "index.js")) &&
    fs.existsSync(path.join(DEST, "dist", "cjs", "index.js"))
  ) {
    console.log("[install-bindings] vendor/xelma-bindings already built, skipping.");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xelma-bindings-"));
  console.log(`[install-bindings] Sparse-cloning ${REPO_URL}#${BRANCH}/${SUBDIR}`);

  try {
    run("git init", tmp);
    run(`git remote add origin ${REPO_URL}`, tmp);
    run("git config core.sparseCheckout true", tmp);
    fs.writeFileSync(path.join(tmp, ".git", "info", "sparse-checkout"), `${SUBDIR}/\n`);
    run(`git fetch --depth=1 origin ${BRANCH}`, tmp);
    run("git checkout FETCH_HEAD", tmp);

    const srcDir = path.join(tmp, SUBDIR);

    console.log("[install-bindings] Installing bindings dependencies…");
    run("npm install --ignore-scripts", srcDir);

    console.log("[install-bindings] Building ESM output…");
    run("npx tsc", srcDir);

    console.log("[install-bindings] Building CJS output…");
    const cjsTsConfigPath = path.join(srcDir, "tsconfig.cjs.json");
    fs.writeFileSync(cjsTsConfigPath, JSON.stringify(CJS_TSCONFIG, null, 2));
    run(`npx tsc -p tsconfig.cjs.json`, srcDir);

    // Add a package.json marker in dist/cjs so Node knows it's CJS
    fs.writeFileSync(
      path.join(srcDir, "dist", "cjs", "package.json"),
      JSON.stringify({ type: "commonjs" }, null, 2)
    );

    console.log(`[install-bindings] Copying to ${DEST}…`);
    fs.mkdirSync(DEST, { recursive: true });
    copyDir(srcDir, DEST);

    // Patch the package.json: rename to @tevalabs/xelma-bindings and add CJS export
    patchPackageJson(path.join(DEST, "package.json"));

    console.log("[install-bindings] Done ✓");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function patchPackageJson(pkgPath) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.name = "@tevalabs/xelma-bindings";
  pkg.exports = {
    ".": {
      require: "./dist/cjs/index.js",
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    },
  };
  pkg.main = "./dist/cjs/index.js";
  pkg.typings = "./dist/index.d.ts";
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

function copyDir(src, dest) {
  const SKIP = new Set(["node_modules", ".git"]);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

main();
