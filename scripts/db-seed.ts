#!/usr/bin/env ts-node
/**
 * Unified database seed entrypoint (Issue #434).
 *
 * SEED_PROFILE=hackathon | full
 * Defaults: DATA_MODE=mock → hackathon, otherwise full.
 */
import { spawnSync } from "child_process";

const profile =
  process.env.SEED_PROFILE ??
  (process.env.DATA_MODE === "mock" ? "hackathon" : "full");

function run(label: string, command: string, args: string[]): void {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Seeding profile: ${profile}`);

if (profile === "hackathon") {
  run("Hackathon Drizzle seed", "npx", ["ts-node", "src/db/seed.ts"]);
} else if (profile === "full") {
  run("Prisma mock platform seed", "npx", ["ts-node", "scripts/seed-mock-data.ts"]);
  run("Prisma development seed", "npx", ["ts-node", "prisma/seed.ts"]);
} else {
  console.error(`Unknown SEED_PROFILE "${profile}". Use hackathon or full.`);
  process.exit(1);
}

console.log("\nSeed complete.");
