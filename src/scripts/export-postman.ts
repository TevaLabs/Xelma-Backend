import fs from 'fs';
import path from 'path';
import converter from 'openapi-to-postmanv2';

type ConversionResult = {
  result: boolean;
  reason?: string;
  output?: Array<{
    type: 'collection' | string;
    data: unknown;
  }>;
};

function main() {
  const docsDir = path.join(process.cwd(), 'docs');
  const openApiPath = path.join(docsDir, 'openapi.json');
  const outPath = path.join(docsDir, 'postman-collection.json');

  if (!fs.existsSync(openApiPath)) {
    throw new Error(
      `OpenAPI spec not found at ${openApiPath}. Run \"yarn docs:openapi\" first.`
    );
  }

  const openapi = JSON.parse(fs.readFileSync(openApiPath, 'utf-8'));

  converter.convert(
    { type: 'json', data: openapi },
    { schemaFaker: true, requestNameSource: 'fallback' },
    (err: unknown, conversionResult: ConversionResult) => {
      if (err) throw err;
      if (!conversionResult?.result) {
        throw new Error(conversionResult?.reason || 'OpenAPI → Postman conversion failed');
      }

      const collection = conversionResult.output?.find((o) => o.type === 'collection')?.data;
      if (!collection) {
        throw new Error('Postman collection missing from conversion output');
      }

      fs.mkdirSync(docsDir, { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(collection, null, 2), 'utf-8');
      // eslint-disable-next-line no-console
      console.log(`Wrote Postman collection to ${outPath}`);
    }
  );
}

main();

