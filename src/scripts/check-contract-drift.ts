import fs from 'fs';
import path from 'path';

// ── Constants ──────────────────────────────────────────────────────────────────

// Must match app.use() mount points in src/index.ts exactly.
// If you add or remove a router, update this map too.
const MOUNT_POINTS: Record<string, string> = {
  'auth.routes.ts': '/api/auth',
  'user.routes.ts': '/api/user',
  'rounds.routes.ts': '/api/rounds',
  'predictions.routes.ts': '/api/predictions',
  'education.routes.ts': '/api/education',
  'leaderboard.routes.ts': '/api/leaderboard',
  'chat.routes.ts': '/api/chat',
  'notifications.routes.ts': '/api/notifications',
  'admin-metrics.routes.ts': '/api/admin/metrics',
  'metrics.routes.ts': '/metrics',
};

// Infra/meta routes defined directly in src/index.ts — intentionally not part of the API contract.
const EXEMPT_FROM_SPEC = new Set([
  'GET /',
  'GET /health',
  'GET /api/price',
  'GET /docs',
  'GET /api-docs.json',
  'GET /api-docs',
]);

// ── Types ──────────────────────────────────────────────────────────────────────

interface Route {
  method: string;
  path: string;
  source: string;
}

interface ZodField {
  name: string;
  type: string; // 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any' | 'unknown'
  optional: boolean;
}

interface SchemaDrift {
  route: string;
  schemaName: string;
  issues: string[];
}

// ── Path/method helpers ────────────────────────────────────────────────────────

function normalizeExpressPath(p: string): string {
  return p.replace(/:([^/]+)/g, '{$1}');
}

function routeKey(r: Pick<Route, 'method' | 'path'>): string {
  return `${r.method} ${r.path}`;
}

function extractRoutesFromFile(filePath: string, mountPoint: string): Route[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);
  const routes: Route[] = [];

  const pattern = /router\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const routePath = match[2];
    const fullPath = mountPoint + (routePath === '/' ? '' : routePath);
    routes.push({ method, path: normalizeExpressPath(fullPath), source: fileName });
  }

  return routes;
}

function loadSpec(specPath: string): Record<string, any> {
  if (!fs.existsSync(specPath)) {
    console.error(`\nERROR: OpenAPI spec not found at: ${specPath}`);
    console.error('Generate it first with: npm run docs:generate\n');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(specPath, 'utf-8'));
}

function extractSpecRoutes(spec: Record<string, any>): Route[] {
  const routes: Route[] = [];
  const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

  for (const [p, pathItem] of Object.entries<Record<string, unknown>>(spec.paths ?? {})) {
    for (const method of httpMethods) {
      if (pathItem[method]) {
        routes.push({ method: method.toUpperCase(), path: p, source: 'openapi.json' });
      }
    }
  }

  return routes;
}

// ── Low-level parsers ─────────────────────────────────────────────────────────

/**
 * Starting right after an opening `{`, scan forward tracking brace depth
 * and return the content up to (but not including) the matching `}`.
 */
function extractBraceBody(content: string, startIdx: number): string | null {
  let depth = 1;
  let i = startIdx;
  let inString: string | null = null;

  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; }
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    i++;
  }

  if (depth !== 0) return null;
  return content.slice(startIdx, i - 1);
}

/**
 * Starting right after an opening `(`, scan forward tracking paren depth
 * and return the content up to (but not including) the matching `)`.
 */
function extractParenBody(content: string, startIdx: number): string | null {
  let depth = 1;
  let i = startIdx;
  let inString: string | null = null;

  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; }
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    i++;
  }

  if (depth !== 0) return null;
  return content.slice(startIdx, i - 1);
}

// ── Zod schema parser ─────────────────────────────────────────────────────────

function inferZodType(valueStr: string): string {
  if (/z\s*\.string/.test(valueStr)) return 'string';
  if (/z\s*\.number/.test(valueStr)) return 'number';
  if (/z\s*\.boolean/.test(valueStr)) return 'boolean';
  if (/z\s*\.array/.test(valueStr)) return 'array';
  if (/z\s*\.object/.test(valueStr)) return 'object';
  if (/z\s*\.enum/.test(valueStr)) return 'string';   // enums are string-typed in JSON Schema
  if (/z\s*\.literal/.test(valueStr)) return 'string';
  if (/z\s*\.union/.test(valueStr)) return 'any';     // union types are not easily inferred
  if (/z\s*\.record/.test(valueStr)) return 'object';
  if (/z\s*\.preprocess/.test(valueStr)) return 'unknown'; // preprocessed values need runtime info
  return 'unknown';
}

/**
 * Scan the body of a z.object({...}) and return only the top-level fields.
 * Tracks bracket depth so nested objects don't pollute the field list.
 */
function extractTopLevelZodFields(body: string): ZodField[] {
  const fields: ZodField[] = [];
  let depth = 0;
  let i = 0;
  let inString: string | null = null;

  while (i < body.length) {
    const ch = body[i];

    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; i++; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth++; i++; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth--; i++; continue; }

    // At depth 0, look for "fieldName:"
    if (depth === 0) {
      const remaining = body.slice(i);
      const fieldMatch = remaining.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/);
      if (fieldMatch) {
        const fieldName = fieldMatch[1];
        const valueStart = i + fieldMatch[0].length;

        // Collect the field's value until the next depth-0 comma or end of body
        let vDepth = 0;
        let j = valueStart;
        let vInString: string | null = null;

        while (j < body.length) {
          const vc = body[j];
          if (vInString) {
            if (vc === '\\') { j += 2; continue; }
            if (vc === vInString) vInString = null;
          } else {
            if (vc === '"' || vc === "'" || vc === '`') { vInString = vc; }
            else if (vc === '(' || vc === '{' || vc === '[') vDepth++;
            else if (vc === ')' || vc === '}' || vc === ']') {
              if (vDepth === 0) break; // Hit the closing bracket of the parent object
              vDepth--;
            }
            else if (vc === ',' && vDepth === 0) { j++; break; }
          }
          j++;
        }

        const valueStr = body.slice(valueStart, j).trim();
        const type = inferZodType(valueStr);
        const optional =
          /\.optional\s*\(\s*\)/.test(valueStr) ||
          /\.nullish\s*\(\s*\)/.test(valueStr) ||
          /\.default\s*\(/.test(valueStr);

        fields.push({ name: fieldName, type, optional });
        i = j;
        continue;
      }
    }

    i++;
  }

  return fields;
}

/**
 * Scan src/schemas/*.ts and build a registry of { schemaName → ZodField[] }.
 * Only exported z.object schemas are indexed.
 */
function buildSchemaRegistry(schemasDir: string): Record<string, ZodField[]> {
  const registry: Record<string, ZodField[]> = {};
  const files = fs.readdirSync(schemasDir).filter(f => f.endsWith('.ts'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(schemasDir, file), 'utf-8');
    const exportPattern = /export\s+const\s+(\w+)\s*=/g;
    let match: RegExpExecArray | null;

    while ((match = exportPattern.exec(content)) !== null) {
      const schemaName = match[1];
      const afterExport = content.slice(match.index);

      // Find the first .object({ after this export declaration
      const objectMatch = afterExport.match(/\.object\s*\(\s*\{/);
      if (!objectMatch || objectMatch.index === undefined) continue;

      const bodyStart = match.index + objectMatch.index + objectMatch[0].length;
      const body = extractBraceBody(content, bodyStart);
      if (body === null) continue;

      const fields = extractTopLevelZodFields(body);
      if (fields.length > 0) {
        registry[schemaName] = fields;
      }
    }
  }

  return registry;
}

// ── Route-to-schema mapping ────────────────────────────────────────────────────

/**
 * For each route file, find router.METHOD('/path', ..., validate(schema), ...)
 * calls and return a map of "METHOD /full/path" → "schemaName".
 *
 * Only body validators are captured: validate(schema) with NO second argument.
 * Query/param validators use validate(schema, 'query'/'params') and are skipped.
 */
function buildRouteSchemaMap(
  routesDir: string,
  mountPoints: Record<string, string>,
): Map<string, string> {
  const routeSchemaMap = new Map<string, string>();
  const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts'));

  for (const file of files) {
    const mountPoint = mountPoints[file];
    if (!mountPoint) continue;

    const content = fs.readFileSync(path.join(routesDir, file), 'utf-8');
    const routeStartPattern = /router\.(get|post|put|patch|delete|head|options)\s*\(/gi;
    let match: RegExpExecArray | null;

    while ((match = routeStartPattern.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const blockStart = match.index + match[0].length;
      const block = extractParenBody(content, blockStart);
      if (!block) continue;

      // Extract path from the first string argument
      const pathMatch = block.match(/^\s*['"`]([^'"`]+)['"`]/);
      if (!pathMatch) continue;
      const routePath = pathMatch[1];

      // Find validate(schemaName) — body validator has exactly one argument (no 'query'/'params')
      const validateMatch = block.match(/\bvalidate\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/);
      if (!validateMatch) continue;

      const schemaName = validateMatch[1];
      const fullPath = normalizeExpressPath(mountPoint + (routePath === '/' ? '' : routePath));
      routeSchemaMap.set(`${method} ${fullPath}`, schemaName);
    }
  }

  return routeSchemaMap;
}

// ── OpenAPI spec helpers ───────────────────────────────────────────────────────

function resolveRef(
  spec: Record<string, any>,
  ref: string,
): Record<string, any> | null {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let current: any = spec;
  for (const part of parts) {
    current = current?.[part];
    if (current === undefined) return null;
  }
  return current as Record<string, any>;
}

function getRequestBodySchema(
  spec: Record<string, any>,
  specPath: string,
  method: string,
): { properties: Record<string, any>; required: string[] } | null {
  const pathItem = spec.paths?.[specPath];
  if (!pathItem) return null;

  const operation = pathItem[method.toLowerCase()];
  if (!operation?.requestBody) return null;

  let schema = operation.requestBody?.content?.['application/json']?.schema;
  if (!schema) return null;

  if (schema.$ref) {
    schema = resolveRef(spec, schema.$ref);
    if (!schema) return null;
  }

  return {
    properties: schema.properties ?? {},
    required: schema.required ?? [],
  };
}

// ── Schema conformity check ────────────────────────────────────────────────────

function checkSchemaConformity(
  spec: Record<string, any>,
  routeSchemaMap: Map<string, string>,
  schemaRegistry: Record<string, ZodField[]>,
): SchemaDrift[] {
  const drifts: SchemaDrift[] = [];

  for (const [key, schemaName] of routeSchemaMap) {
    const spaceIdx = key.indexOf(' ');
    const method = key.slice(0, spaceIdx);
    const specPath = key.slice(spaceIdx + 1);

    const zodFields = schemaRegistry[schemaName];
    if (!zodFields) continue; // Inline or composed schema — not in registry, skip

    const specBody = getRequestBodySchema(spec, specPath, method);
    if (!specBody) continue; // No requestBody in spec — already caught by path check

    const issues: string[] = [];
    const { properties: specProps, required: specRequired } = specBody;
    const specRequiredSet = new Set(specRequired);
    const zodFieldMap = new Map(zodFields.map(f => [f.name, f]));

    // Zod required fields missing from spec required[]
    for (const field of zodFields) {
      if (!field.optional && !specRequiredSet.has(field.name)) {
        issues.push(`"${field.name}" is required in Zod but missing from spec required[]`);
      }
    }

    // spec required[] fields that are optional in Zod
    for (const reqField of specRequired) {
      const zodField = zodFieldMap.get(reqField);
      if (zodField?.optional) {
        issues.push(`"${reqField}" is required in spec but optional in Zod schema`);
      }
    }

    // Zod fields not documented in spec properties
    for (const field of zodFields) {
      if (!specProps[field.name]) {
        issues.push(`"${field.name}" is in Zod schema but not documented in spec properties`);
      }
    }

    // spec properties without a corresponding Zod field
    for (const propName of Object.keys(specProps)) {
      if (!zodFieldMap.has(propName)) {
        issues.push(`"${propName}" is documented in spec but not found in Zod schema`);
      }
    }

    // Basic type mismatches — skip unknown/any types that can't be inferred statically
    for (const field of zodFields) {
      const specField = specProps[field.name];
      if (!specField) continue;
      const rawSpecType: string | undefined = specField.type;
      if (!rawSpecType || field.type === 'unknown' || field.type === 'any') continue;
      // OpenAPI 'integer' is a subtype of 'number' — treat as compatible
      const normalizedSpecType = rawSpecType === 'integer' ? 'number' : rawSpecType;
      if (normalizedSpecType !== field.type) {
        issues.push(`"${field.name}" type mismatch: Zod="${field.type}", spec="${rawSpecType}"`);
      }
    }

    if (issues.length > 0) {
      drifts.push({ route: key, schemaName, issues });
    }
  }

  return drifts;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const cwd = process.cwd();
  const routesDir = path.join(cwd, 'src', 'routes');
  const schemasDir = path.join(cwd, 'src', 'schemas');
  const specPath = path.join(cwd, 'docs', 'openapi.json');

  // ── 1. Collect routes from code ────────────────────────────────────────────

  const codeRoutes: Route[] = [];
  const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts'));

  for (const file of routeFiles) {
    const mountPoint = MOUNT_POINTS[file];
    if (!mountPoint) {
      console.warn(`  WARN: No mount point configured for ${file} — skipping`);
      console.warn(`        If this router is active, add it to MOUNT_POINTS in check-contract-drift.ts`);
      continue;
    }
    codeRoutes.push(...extractRoutesFromFile(path.join(routesDir, file), mountPoint));
  }

  // ── 2. Load spec and extract documented routes ─────────────────────────────

  const spec = loadSpec(specPath);
  const specRoutes = extractSpecRoutes(spec);

  // ── 3. Path/method drift ───────────────────────────────────────────────────

  const codeKeys = new Set(codeRoutes.map(routeKey));
  const specKeys = new Set(specRoutes.map(routeKey));

  const missingFromCode = specRoutes.filter(r => !codeKeys.has(routeKey(r)));
  const missingFromSpec = codeRoutes.filter(
    r => !specKeys.has(routeKey(r)) && !EXEMPT_FROM_SPEC.has(routeKey(r)),
  );

  // ── 4. Schema conformity drift ─────────────────────────────────────────────

  const schemaRegistry = buildSchemaRegistry(schemasDir);
  const routeSchemaMap = buildRouteSchemaMap(routesDir, MOUNT_POINTS);
  const schemaDrifts = checkSchemaConformity(spec, routeSchemaMap, schemaRegistry);

  // ── 5. Report ──────────────────────────────────────────────────────────────

  let hasDrift = false;

  if (missingFromCode.length > 0) {
    hasDrift = true;
    console.log('\n❌ [PATH DRIFT] Routes documented in spec but NOT found in code:');
    for (const r of missingFromCode) {
      console.log(`   ${r.method} ${r.path}`);
    }
    console.log('   → Remove from the spec, or implement the missing route.');
  }

  if (missingFromSpec.length > 0) {
    hasDrift = true;
    console.log('\n❌ [PATH DRIFT] Routes in code but NOT documented in spec:');
    for (const r of missingFromSpec) {
      console.log(`   ${r.method} ${r.path}  (${r.source})`);
    }
    console.log('   → Add a @swagger/@openapi JSDoc block to the route handler.');
  }

  if (schemaDrifts.length > 0) {
    hasDrift = true;
    console.log('\n❌ [SCHEMA DRIFT] Request body schema mismatches:');
    for (const drift of schemaDrifts) {
      console.log(`\n   ${drift.route}  [${drift.schemaName}]`);
      for (const issue of drift.issues) {
        console.log(`     • ${issue}`);
      }
    }
    console.log('\n   → Align the Zod schema with the spec requestBody, or update the spec.');
  }

  if (hasDrift) {
    console.log('\n💥 Contract drift detected! Fix the mismatch before merging.');
    console.log('   See docs/contract-drift.md for step-by-step instructions.\n');
    process.exit(1);
  }

  const schemasChecked = [...routeSchemaMap.values()].filter(s => schemaRegistry[s]).length;
  console.log(
    `\n✅ No contract drift detected. ` +
    `${specRoutes.length} route(s) and ${schemasChecked} request schema(s) verified.\n`,
  );
}

main();
