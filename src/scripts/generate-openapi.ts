import fs from 'fs';
import path from 'path';
import { swaggerSpec } from '../docs/openapi';

function main() {
  const outDir = path.join(process.cwd(), 'docs');
  const outPath = path.join(outDir, 'openapi.json');

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(swaggerSpec, null, 2), 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`Wrote OpenAPI spec to ${outPath}`);
}

main();

