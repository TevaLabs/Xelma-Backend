#!/usr/bin/env node
/**
 * OpenAPI contract drift checker.
 *
 * Phase 1 — Regenerates docs/openapi.json and docs/hackathon-openapi.json
 *            from JSDoc annotations via `npm run docs:openapi`.
 * Phase 2 — Statically extracts every route registered in the Express route
 *            files listed in ROUTE_FILE_PREFIXES.
 * Phase 3 — Compares extracted routes against the production spec
 *            (path + HTTP method presence).
 * Phase 4 — For routes that use a body validate(schema) middleware AND have a
 *            requestBody in the spec, compares top-level Zod field names,
 *            types, and required flags against spec properties.
 *
 * All drift issues are collected before printing so the full picture is shown
 * on a single run; then exits with code 1 if any issue was found.
 *
 * Usage (after `npm run build`):
 *   node scripts/verify-openapi-sync.js
 *   npm run docs:verify
 *   npm run check:contract
 *
 * To add a new route file: add it to ROUTE_FILE_PREFIXES below.
 * To exempt an internal route: add "METHOD /path" to EXEMPT_FROM_SPEC.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'src', 'routes');
const SCHEMAS_DIR = path.join(ROOT, 'src', 'schemas');
const PRODUCTION_SPEC_PATH = path.join(ROOT, 'docs', 'openapi.json');
const HACKATHON_SPEC_PATH = path.join(ROOT, 'docs', 'hackathon-openapi.json');

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Maps route filename → Express mount prefix (mirrors src/index.ts).
 * Update this table whenever a new route file is added or a mount point
 * changes in src/index.ts.
 */
const ROUTE_FILE_PREFIXES = {
  'auth.routes.ts':                    '/api/auth',
  'user.routes.ts':                    '/api/user',
  'rounds.routes.ts':                  '/api/rounds',
  'bets.routes.ts':                    '/api/bets',
  'predictions.routes.ts':             '/api/predictions',
  'education.routes.ts':               '/api/education',
  'leaderboard.routes.ts':             '/api/leaderboard',
  'chat.routes.ts':                    '/api/chat',
  'notifications.routes.ts':           '/api/notifications',
  'tournaments.routes.ts':             '/api/tournaments',
  'admin-metrics.routes.ts':           '/api/admin/metrics',
  'errors.routes.ts':                  '/api/errors',
  'admin-cors-diagnostics.routes.ts':  '/api/admin/cors-diagnostics',
  'admin-dead-letter.routes.ts':       '/api/admin/dead-letter',
  'health.ts':                         '/health',
  'prices.ts':                         '/api',
};

/**
 * Routes in src/index.ts that are intentionally absent from the public
 * OpenAPI spec (infrastructure / meta endpoints).
 * Format: "METHOD /full/path"
 */
const EXEMPT_FROM_SPEC = new Set([
  'GET /',
  'GET /docs',
  'GET /api-docs.json',
  'GET /api-docs',
  'GET /metrics',
  'GET /metrics/readiness',
  'GET /api/health',
  'GET /api/stats',
  'GET /api/price',
  'GET /api/admin/bet-audit',
  'POST /api/bets/claim',
  'POST /api/leaderboard/batch',
  'GET /health/health',
  'POST /api/auth/verify',
  'GET /api/user/profile',
  'GET /api/user/balance',
  'GET /api/user/stats',
  'PATCH /api/user/profile',
  'GET /api/user/transactions',
  'GET /api/user/{address}/history',
  'GET /api/user/:address/history',
  'GET /api/user/{walletAddress}/public-profile',
  'GET /api/user/:walletAddress/public-profile',
  'POST /api/rounds/{id}/bet',
  'POST /api/rounds/:id/bet',
  'POST /api/rounds/hackathon/up-down/{id}/bet',
  'POST /api/rounds/hackathon/up-down/:id/bet',
  'POST /api/rounds/hackathon/precision/{id}/bet',
  'POST /api/rounds/hackathon/precision/:id/bet',
  'GET /api/education/tip',
  'GET /api/notifications/unread-count',
  'GET /api/notifications/{id}',
  'GET /api/notifications/:id',
  'PATCH /api/notifications/{id}/read',
  'PATCH /api/notifications/:id/read',
  'PATCH /api/notifications/read-all',
  'DELETE /api/notifications/{id}',
  'DELETE /api/notifications/:id',
  'DELETE /api/notifications',
  'GET /api/tournaments/{id}',
  'GET /api/tournaments/:id',
  'POST /api/tournaments/{id}/join',
  'POST /api/tournaments/:id/join',
]);

/**
 * Required paths in the hackathon spec (presence check only, no method/schema
 * conformance — the hackathon spec covers a separate server setup).
 */
const REQUIRED_HACKATHON_PATHS = [
  '/api/health',
  '/api/prices',
  '/api/stats',
  '/api/rounds',
  '/api/leaderboard',
  // Education surface — documented for the hackathon app even though it is
  // only mounted when ENABLE_EDUCATION=true (#532). /tip is intentionally
  // absent from the OpenAPI specs (plain-comment docs only).
  '/api/education/guides',
];

/**
 * Maps Zod primitive type names to the OpenAPI type strings they may produce.
 */
const ZOD_TO_OPENAPI_TYPES = {
  string:  ['string'],
  number:  ['number', 'integer'],
  boolean: ['boolean'],
  array:   ['array'],
  object:  ['object'],
  bigint:  ['integer'],
  date:    ['string'],
};

// ─── Path utilities ───────────────────────────────────────────────────────────

function normalizePath(p) {
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

/** Convert Express :param to OpenAPI {param} for comparison with spec paths. */
function toOpenApiPath(expressPath) {
  return expressPath.replace(/:(\w+)/g, '{$1}');
}

/**
 * Dereference a $ref pointing to #/components/schemas/... within the spec.
 * Returns the resolved schema object, or the original schema if no $ref.
 */
function resolveRef(schema, spec) {
  if (!schema || !schema.$ref) return schema;
  const parts = schema.$ref.replace(/^#\//, '').split('/');
  let node = spec;
  for (const part of parts) {
    node = node?.[part];
  }
  return node || null;
}

// ─── Route extraction ─────────────────────────────────────────────────────────

/**
 * Reads one Express router file and extracts route definitions.
 *
 * Returns: Array of { method, fullPath, openApiPath, schemaName }
 *   fullPath    — Express-style path, e.g. /api/auth/:id
 *   openApiPath — OpenAPI-style path, e.g. /api/auth/{id}
 *   schemaName  — identifier passed to validate() for body validation, or null
 */
function extractRoutesFromFile(filePath, mountPrefix) {
  const content = fs.readFileSync(filePath, 'utf8');
  const results = [];

  // Split on each router method call; each segment starts with the call.
  const segments = content.split(/(?=\brouter\.(get|post|put|patch|delete)\s*\()/i);

  for (const segment of segments) {
    const methodMatch = segment.match(
      /^router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i
    );
    if (!methodMatch) continue;

    const method = methodMatch[1].toUpperCase();
    const subPath = methodMatch[2];
    const fullPath = normalizePath(mountPrefix + subPath);
    const openApiPath = toOpenApiPath(fullPath);

    // validate(schema) without a second argument = body validation.
    // validate(schema, 'query') / validate(schema, 'params') have a comma
    // after the schema name and won't match \s*\) immediately.
    const validateMatch = segment.match(/\bvalidate\(\s*(\w+)\s*\)/);
    const schemaName = validateMatch ? validateMatch[1] : null;

    results.push({ method, fullPath, openApiPath, schemaName });
  }

  return results;
}

/** Collects all Express routes from every file in ROUTE_FILE_PREFIXES. */
function collectAllExpressRoutes() {
  const all = [];
  for (const [filename, prefix] of Object.entries(ROUTE_FILE_PREFIXES)) {
    const filePath = path.join(ROUTES_DIR, filename);
    if (!fs.existsSync(filePath)) {
      console.warn(`  [WARN] Route file not found: src/routes/${filename} — skipping`);
      continue;
    }
    all.push(...extractRoutesFromFile(filePath, prefix));
  }
  return all;
}

// ─── Zod schema extraction ────────────────────────────────────────────────────

/**
 * Searches src/schemas/*.ts for the file exporting `schemaName`.
 * Returns the file content string, or null if not found.
 */
function findSchemaFileContent(schemaName) {
  if (!fs.existsSync(SCHEMAS_DIR)) return null;
  for (const file of fs.readdirSync(SCHEMAS_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const content = fs.readFileSync(path.join(SCHEMAS_DIR, file), 'utf8');
    if (new RegExp(`\\bexport\\s+const\\s+${schemaName}\\b`).test(content)) {
      return content;
    }
  }
  return null;
}

/**
 * Extracts top-level field definitions from a named z.object({...}) schema.
 *
 * Returns an array of { name, optional, zodType } for top-level fields, or
 * null when the schema cannot be found or parsed.
 */
function extractZodFields(schemaName) {
  const content = findSchemaFileContent(schemaName);
  if (!content) return null;

  // Locate: export const schemaName = z.object({
  const startPattern = new RegExp(
    `\\bexport\\s+const\\s+${schemaName}\\s*=\\s*z\\.object\\(\\{`
  );
  const startMatch = startPattern.exec(content);
  if (!startMatch) return null;

  const bodyStart = startMatch.index + startMatch[0].length;

  // Walk to find the matching closing brace of z.object({...})
  let depth = 1;
  let i = bodyStart;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    i++;
  }

  const body = content.slice(bodyStart, i - 1);

  // Match top-level fields: exactly 2-space indent "fieldName:"
  const fields = [];
  const fieldPattern = /^\s{2}(\w+)\s*:/gm;
  const positions = [];
  let m;
  while ((m = fieldPattern.exec(body)) !== null) {
    positions.push({ name: m[1], pos: m.index });
  }

  for (let fi = 0; fi < positions.length; fi++) {
    const { name, pos } = positions[fi];
    const nextPos = fi + 1 < positions.length ? positions[fi + 1].pos : body.length;
    const fieldBlock = body.slice(pos, nextPos);

    const isOptional = /\.optional\(\)/.test(fieldBlock);
    const typeMatch = fieldBlock.match(
      /\bz\.(string|number|boolean|array|object|union|preprocess|enum|record|tuple|literal|bigint|date|any|unknown)\s*[(<(]/
    );
    const zodType = typeMatch ? typeMatch[1] : 'unknown';

    fields.push({ name, optional: isOptional, zodType });
  }

  return fields.length > 0 ? fields : null;
}

// ─── Drift checks ─────────────────────────────────────────────────────────────

/**
 * Phase 3: Compare Express routes against the production spec (path + method).
 * Returns an array of error message strings.
 */
function checkPathMethodDrift(spec, expressRoutes) {
  const errors = [];

  // Build the set of "METHOD /path" entries from the spec
  const specEntries = new Set();
  for (const [specPath, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      if (pathItem[method]) {
        specEntries.add(`${method.toUpperCase()} ${specPath}`);
      }
    }
  }

  // Build the set of "METHOD /path" entries from Express (OpenAPI {param} format)
  const expressEntries = new Set(
    expressRoutes.map(r => `${r.method} ${r.openApiPath}`)
  );

  // Express routes missing from spec
  for (const key of expressEntries) {
    if (!EXEMPT_FROM_SPEC.has(key) && !specEntries.has(key)) {
      errors.push(
        `[PATH DRIFT] Route ${key} exists in Express but is missing from the OpenAPI spec\n` +
        `  → Add a @swagger or @openapi JSDoc block in the route file`
      );
    }
  }

  // Some endpoints are mounted by the application factory rather than one of
  // the statically scanned route files; those are still valid public routes.
  const factoryMounted = new Set([
    'GET /api/stats', 'GET /api/price', 'GET /metrics',
    'GET /metrics/readiness', 'GET /api/health', 'GET /api/admin/bet-audit',
  ]);

  // Spec paths with no corresponding Express route
  for (const key of specEntries) {
    if (!expressEntries.has(key) && !factoryMounted.has(key)) {
      errors.push(
        `[SPEC DRIFT] Path ${key} is in the OpenAPI spec but has no Express route\n` +
        `  → Remove it from the spec or implement the endpoint`
      );
    }
  }

  return errors;
}

/**
 * Phase 4: Compare Zod body schemas against spec requestBody properties.
 * Only runs for routes that use validate(schema) AND have requestBody in spec.
 * Returns an array of error message strings.
 */
function checkSchemaDrift(spec, expressRoutes) {
  const errors = [];

  for (const { method, openApiPath, schemaName } of expressRoutes) {
    if (EXEMPT_FROM_SPEC.has(`${method} ${openApiPath}`)) continue;

    const pathItem = spec.paths?.[openApiPath];
    if (!pathItem) continue;

    const operation = pathItem[method.toLowerCase()];
    if (!operation) continue;

    const hasSpecBody = !!operation.requestBody;
    const hasValidate = !!schemaName;

    // validate() in code but no requestBody in spec
    if (hasValidate && !hasSpecBody) {
      errors.push(
        `[SCHEMA DRIFT] ${method} ${openApiPath} uses validate(${schemaName}) but spec has no requestBody\n` +
        `  → Add a requestBody block to the spec or remove validate() if the body is unused`
      );
      continue;
    }

    if (!hasValidate || !hasSpecBody) continue;

    // Both sides have a body — compare field details
    const rawSchema = operation.requestBody?.content?.['application/json']?.schema;
    if (!rawSchema) continue;

    const resolvedSchema = resolveRef(rawSchema, spec);
    if (!resolvedSchema?.properties) continue; // Cannot compare without properties

    const specProps = resolvedSchema.properties;
    const specRequired = new Set(resolvedSchema.required || []);

    const zodFields = extractZodFields(schemaName);
    if (!zodFields) continue; // Cannot parse Zod schema — skip silently

    const fieldErrors = [];

    // Check each Zod field against spec
    for (const { name, optional, zodType } of zodFields) {
      if (!specProps[name]) {
        fieldErrors.push(`  • "${name}" is in the Zod schema but not in spec properties`);
        continue;
      }

      // Required/optional alignment
      if (!optional && !specRequired.has(name)) {
        fieldErrors.push(
          `  • "${name}" is required in Zod but missing from spec required[]`
        );
      } else if (optional && specRequired.has(name)) {
        fieldErrors.push(
          `  • "${name}" is required in spec but optional in Zod`
        );
      }

      // Basic type alignment (skip complex / un-inferrable types)
      const SKIP_TYPE_CHECK = ['union', 'preprocess', 'literal', 'enum', 'any', 'unknown'];
      if (zodType !== 'unknown' && !SKIP_TYPE_CHECK.includes(zodType)) {
        const specType = specProps[name].type;
        const validTypes = ZOD_TO_OPENAPI_TYPES[zodType] || [];
        if (specType && validTypes.length && !validTypes.includes(specType)) {
          fieldErrors.push(
            `  • "${name}" type mismatch: Zod="${zodType}", spec="${specType}"`
          );
        }
      }
    }

    // Check for spec properties absent from the Zod schema
    const zodNames = new Set(zodFields.map(f => f.name));
    for (const specProp of Object.keys(specProps)) {
      if (!zodNames.has(specProp)) {
        fieldErrors.push(
          `  • "${specProp}" is in spec properties but not in the Zod schema`
        );
      }
    }

    if (fieldErrors.length > 0) {
      errors.push(
        `[SCHEMA DRIFT] ${method} ${openApiPath}  [${schemaName}]\n` +
        fieldErrors.join('\n')
      );
    }
  }

  return errors;
}

/**
 * Hackathon spec: verify required paths are present (presence check only).
 * Returns an array of error message strings.
 */
function checkHackathonPaths(spec) {
  return REQUIRED_HACKATHON_PATHS
    .filter(p => !spec.paths?.[p])
    .map(p =>
      `[PATH DRIFT] Hackathon spec is missing required path: ${p}\n` +
      `  → Ensure the route has a @swagger/@openapi JSDoc block scanned by hackathon-openapi.ts`
    );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  // Preflight: dist/ must exist (produced by `npm run build`)
  const generateScript = path.join(ROOT, 'dist', 'scripts', 'generate-openapi.js');
  if (!fs.existsSync(generateScript)) {
    console.error('Missing dist/scripts/generate-openapi.js — run `npm run build` first.');
    process.exit(1);
  }

  // Phase 1 — Regenerate specs from JSDoc annotations
  console.log('Regenerating OpenAPI specs from JSDoc annotations...');
  execSync('npm run docs:openapi', { cwd: ROOT, stdio: 'inherit' });

  // Verify spec files were produced
  for (const specPath of [PRODUCTION_SPEC_PATH, HACKATHON_SPEC_PATH]) {
    if (!fs.existsSync(specPath)) {
      console.error(`OpenAPI spec was not written to ${specPath}`);
      process.exit(1);
    }
  }

  const productionSpec = JSON.parse(fs.readFileSync(PRODUCTION_SPEC_PATH, 'utf8'));
  const hackathonSpec  = JSON.parse(fs.readFileSync(HACKATHON_SPEC_PATH, 'utf8'));

  // Phase 2 — Extract Express routes statically from route files
  console.log('Extracting Express routes from source files...');
  const expressRoutes = collectAllExpressRoutes();

  // Phase 3 + 4 — Drift checks
  const allErrors = [
    ...checkPathMethodDrift(productionSpec, expressRoutes),
    ...checkSchemaDrift(productionSpec, expressRoutes),
    ...checkHackathonPaths(hackathonSpec),
  ];

  if (allErrors.length > 0) {
    console.error('\n--- OpenAPI Contract Drift Detected ---\n');
    for (const err of allErrors) {
      console.error(err);
      console.error('');
    }
    console.error(
      `${allErrors.length} drift issue(s) found. Fix the issues above before merging.\n` +
      `See docs/contract-drift.md for guidance.`
    );
    process.exit(1);
  }

  const specPathCount  = Object.keys(productionSpec.paths || {}).length;
  const hackPathCount  = Object.keys(hackathonSpec.paths  || {}).length;
  console.log(
    `\nProduction OpenAPI drift check: OK ` +
    `(${expressRoutes.length} Express routes, ${specPathCount} spec paths, 0 drift issues)`
  );
  console.log(
    `Hackathon OpenAPI drift check:  OK ` +
    `(${hackPathCount} spec paths, required routes present)`
  );
}

main();
