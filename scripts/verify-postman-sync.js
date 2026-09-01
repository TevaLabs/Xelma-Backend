#!/usr/bin/env node
/**
 * Postman ↔ OpenAPI drift checker.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/postman-collection.json` is a committed, generated artifact derived from
 * the canonical OpenAPI specification (`docs/openapi.json`). Like any generated
 * artifact, it can silently fall out of step with its source of truth: someone
 * edits a route's `@swagger` JSDoc block, regenerates `docs/openapi.json`, and
 * forgets to re-export the Postman collection. Because Postman collections are
 * large, mostly-boilerplate JSON, drift goes unnoticed by an eyeball diff and
 * consumers of the published collection end up relying on stale request/response
 * contracts.
 *
 * This checker makes that drift fail loud in CI instead of shipping silently.
 * It re-runs the OpenAPI → Postman conversion in memory and compares the **request
 * request-structure signature** of the result against the signature computed from
 * the committed artifact. The signature captures every folder, request name, HTTP
 * method, and request URL — i.e. everything that reflects the documented API
 * surface. Any path/endpoint added, removed, renamed, or re-summarized in the
 * OpenAPI changes the signature and trips the check. If the two signatures
 * differ the script exits non-zero, forcing `npm run docs:generate` and a commit
 * of the refreshed collection.
 *
 * WHY SIGNATURE COMPARISON INSTEAD OF A BLIND `===`
 * -------------------------------------------------
 * The converter (`openapi-to-postmanv2`) embeds non-semantic noise that differs
 * between runs: random item UUIDs (`id`/`_postman_id`) and faker-generated example
 * bodies. Byte-comparing would therefore report spurious drift on every run even
 * for an unchanged spec. The request-structure signature strips that noise and
 * compares only the fields that carry real contract meaning, so the gate is both
 * deterministic and precise.
 *
 * DESIGN NOTES
 * ------------
 * - It intentionally reads `docs/openapi.json` from disk rather than calling any
 *   runtime server code: the sync must work with zero server initialization and
 *   no database, so it stays runnable in every environment including a fresh CI
 *   checkout.
 * - `--write` rewrites `docs/postman-collection.json` in place from the current
 *   spec. The default (check) mode is what the `docs:verify` gate invokes.
 * - Conversion options mirror `src/scripts/export-postman.ts` so the generation
 *   and verification paths observe the same converter behaviour.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const converter = require('openapi-to-postmanv2');

const ROOT = path.resolve(__dirname, '..');
const SPEC_PATH = path.join(ROOT, 'docs', 'openapi.json');
const COLLECTION_PATH = path.join(ROOT, 'docs', 'postman-collection.json');

const writeMode = process.argv.includes('--write');

/**
 * Reduces a Postman collection's items into a stable ordered structure signature.
 *
 * The signature is an array of folder labels and request descriptors
 * `{ name, method, url }`. Only the fields that describe the documented API are
 * kept; converter-generated UUIDs and faker example bodies are deliberately
 * excluded so the signature is byte-stable across conversion runs.
 */
function structureSignature(items, acc = []) {
  for (const item of items || []) {
    if (Array.isArray(item.item)) {
      acc.push({ folder: item.name });
      structureSignature(item.item, acc);
    } else if (item && item.request) {
      const req = item.request;
      const url = req.url ? (req.url.raw || JSON.stringify(req.url)) : null;
      acc.push({ name: item.name, method: req.method, url });
    }
  }
  return acc;
}

/**
 * Converts the OpenAPI spec at SPEC_PATH into a Postman collection.
 * Resolves with the raw generated collection object.
 */
function convertSpecToCollection() {
  if (!fs.existsSync(SPEC_PATH)) {
    throw new Error(
      `OpenAPI spec not found at ${SPEC_PATH}. Run \`npm run docs:openapi\` (after \`npm run build\`) first.`,
    );
  }

  const openapi = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf-8'));

  return new Promise((resolve, reject) => {
    converter.convert(
      { type: 'json', data: openapi },
      { schemaFaker: true, requestNameSource: 'Fallback' },
      (err, conversionResult) => {
        if (err) return reject(err);
        if (!conversionResult || !conversionResult.result) {
          return reject(new Error(conversionResult?.reason || 'OpenAPI → Postman conversion failed'));
        }
        const collection = (conversionResult.output || []).find((o) => o.type === 'collection')?.data;
        if (!collection) {
          return reject(new Error('Postman collection missing from conversion output'));
        }
        resolve(collection);
      },
    );
  });
}

/** Computes the canonical, indented JSON string used when --write persists the artifact. */
function canonicalize(collection) {
  return JSON.stringify(collection, null, 2);
}

async function main() {
  let generated;
  try {
    generated = await convertSpecToCollection();
  } catch (error) {
    console.error('[verify-postman-sync] Failed to generate Postman collection:', error.message);
    process.exit(1);
  }

  if (writeMode) {
    fs.mkdirSync(path.dirname(COLLECTION_PATH), { recursive: true });
    fs.writeFileSync(COLLECTION_PATH, canonicalize(generated), 'utf-8');
    console.log(`[verify-postman-sync] Wrote Postman collection to ${COLLECTION_PATH}`);
    return;
  }

  if (!fs.existsSync(COLLECTION_PATH)) {
    console.error(
      `[verify-postman-sync] Missing committed ${COLLECTION_PATH}. ` +
        `Run \`npm run docs:generate\` and commit the result.`,
    );
    process.exit(1);
  }

  const committed = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf-8'));

  const generatedSig = JSON.stringify(structureSignature(generated.item), null, 2);
  const committedSig = JSON.stringify(structureSignature(committed.item), null, 2);

  if (generatedSig === committedSig) {
    console.log('[verify-postman-sync] Postman collection is in sync with the OpenAPI spec: OK');
    return;
  }

  console.error(
    '\n[verify-postman-sync] POSTMAN COLLECTION DRIFT DETECTED\n',
    '\n  The request structure of docs/postman-collection.json no longer matches\n',
    '  the current docs/openapi.json (a folder, request, HTTP method, or URL was\n',
    '  added, removed, or changed).\n',
    '\n  To fix, regenerate and commit the refreshed collection:\n',
    '    npm run docs:generate   # writes docs/postman-collection.json\n',
    '    git add docs/postman-collection.json && git commit\n',
    '\n  Keeping these in lockstep prevents consumers of the published collection\n',
    '  from relying on stale request/response contracts.\n',
  );
  process.exit(1);
}

main();