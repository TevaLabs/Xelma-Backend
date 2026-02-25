import fs from "fs";
import path from "path";

function getAllTypeScriptFiles(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...getAllTypeScriptFiles(fullPath));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith(".ts") && !fullPath.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

describe("Prisma singleton usage", () => {
  it("does not instantiate PrismaClient outside src/lib/prisma.ts", () => {
    const srcRoot = path.resolve(__dirname, "..");
    const prismaFactoryFile = path.join(srcRoot, "lib", "prisma.ts");
    const newClientPattern = /\bnew\s+PrismaClient\s*\(/g;
    const offenders: string[] = [];

    for (const filePath of getAllTypeScriptFiles(srcRoot)) {
      if (path.resolve(filePath) === path.resolve(prismaFactoryFile)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf8");
      if (newClientPattern.test(content)) {
        offenders.push(path.relative(srcRoot, filePath));
      }
    }

    expect(offenders).toEqual([]);
  });
});
