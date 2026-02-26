import fs from 'fs';
import path from 'path';
import { swaggerSpec } from '../docs/openapi';
import logger from '../utils/logger';

function main() {
  const outDir = path.join(process.cwd(), 'docs');
  const outPath = path.join(outDir, 'openapi.json');

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(swaggerSpec, null, 2), 'utf-8');
  logger.info(`Wrote OpenAPI spec to ${outPath}`);
}

main();

