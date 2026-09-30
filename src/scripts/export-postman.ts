import fs from 'fs';
import path from 'path';
import converter from 'openapi-to-postmanv2';
import logger from '../utils/logger';

type ConversionResult = {
  result: boolean;
  reason?: string;
  output?: Array<{
    type: string;
    data: unknown;
  }>;
};

function main() {
  const docsDir = path.join(process.cwd(), 'docs');
  const openApiPath = path.join(docsDir, 'openapi.json');
  const outPath = path.join(docsDir, 'postman-collection.json');

  if (!fs.existsSync(openApiPath)) {
    throw new Error(
      `OpenAPI spec not found at ${openApiPath}. Run "npm run docs:openapi" first.`
    );
  }

  const openapi = JSON.parse(fs.readFileSync(openApiPath, 'utf-8'));

  converter.convert(
    { type: 'json', data: openapi },
    { schemaFaker: true, requestNameSource: 'Fallback' },
    (err: unknown, conversionResult?: ConversionResult) => {
      // `convert` is callback-based, so a bare `throw` here escapes into the
      // library's own stack and is swallowed — the process would exit 0 with
      // a stale or missing collection. Reporting and exiting non-zero is the
      // only way CI actually notices a failed sync.
      if (err) {
        logger.error('OpenAPI → Postman conversion failed', {
          error: err instanceof Error ? err.message : JSON.stringify(err),
        });
        process.exit(1);
      }
      if (!conversionResult?.result) {
        logger.error('OpenAPI → Postman conversion failed', {
          reason: conversionResult?.reason ?? 'unknown',
        });
        process.exit(1);
      }

      const collection = conversionResult.output?.find((o) => o.type === 'collection')?.data;
      if (!collection) {
        logger.error('Postman collection missing from conversion output');
        process.exit(1);
      }

      fs.mkdirSync(docsDir, { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(collection, null, 2), 'utf-8');
      logger.info(`Wrote Postman collection to ${outPath}`);
    }
  );
}

main();

