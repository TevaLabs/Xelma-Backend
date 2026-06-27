import fs from 'fs';
import path from 'path';
import { swaggerSpec } from '../docs/openapi';
import { hackathonSwaggerSpec } from '../docs/hackathon-openapi';
import logger from '../utils/logger';

function main() {
  const outDir = path.join(process.cwd(), 'docs');
  fs.mkdirSync(outDir, { recursive: true });

  const productionPath = path.join(outDir, 'openapi.json');
  fs.writeFileSync(productionPath, JSON.stringify(swaggerSpec, null, 2), 'utf-8');
  logger.info(`Wrote OpenAPI spec to ${productionPath}`);

  const hackathonPath = path.join(outDir, 'hackathon-openapi.json');
  fs.writeFileSync(hackathonPath, JSON.stringify(hackathonSwaggerSpec, null, 2), 'utf-8');
  logger.info(`Wrote hackathon OpenAPI spec to ${hackathonPath}`);
}

main();
