#!/usr/bin/env node
/**
 * Postman ↔ OpenAPI sync: generator + drift checker.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/postman-collection.json` is a committed, generated artifact derived from
 * the canonical OpenAPI specification (`docs/openapi.json`). Like any generated
 * artifact, it can silently fall out of step with its source of truth: someone
 * edits a route's `@swagger`/`@openapi` JSDoc block, regenerates
 * `docs/openapi.json`, and forgets to re-export the Postman collection. Because
 * Postman collections are large, mostly-boilerplate JSON, drift goes unnoticed
 * by an eyeball diff and consumers of the published collection end up relying on
 * stale request/response contracts.
 *
 * This script makes that drift fail loud in CI instead of shipping silently.
 * In its default (check) mode it re-runs the OpenAPI → Postman conversion and
 * byte-compares the canonical output against the committed artifact. If they
 * differ it exits non-zero, forcing `npm run docs:generate` and a commit of the
 * refreshed collection.
 *
 * DETERMINISM (issue #655)
 * ------------------------
 * `openapi-to-postmanv2` embeds run-specific noise in its raw output: random
 * item UUIDs (`id`), a random collection `_postman_id`, and faker-generated
 * response example bodies. Committing that raw output produced a different file
 * on every regeneration, so the artifact could never be reproduced and every
 * `--write` produced a noisy diff.
 *
 * `normalizeCollection()` removes that noise, so the persisted file is a pure
 * function of `docs/openapi.json`:
 *   - every `id` is dropped (Postman regenerates item ids on import),
 *   - generated `response` examples are dropped (they were the faker output),
 *   - `info._postman_id` is pinned to a stable, all-zero UUID.
 *
 * Because generation is now deterministic, the check is an exact byte compare
 * rather than a fuzzy structure-signature compare — a stricter gate that also
 * catches response-schema drift.
 *
 * DESIGN NOTES
 * ------------
 * - It intentionally reads `docs/openapi.json` from disk rather than calling any
 *   runtime server code: the sync must work with zero server initialization and
 *   no database, so it stays runnable in every environment including a fresh CI
 *   checkout.
 * - `--write` rewrites `docs/postman-collection.json` in place from the current
 *   spec. The default (check) mode is what the `docs:verify` gate invokes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const converter = require('openapi-to-postmanv2');

const ROOT = path.resolve(__dirname, '..');
const SPEC_PATH = path.join(ROOT, 'docs', 'openapi.json');
const COLLECTION_PATH = path.join(ROOT, 'docs', 'postman-collection.json');

/**
 * Stable collection id. Using a fixed UUID (instead of the converter's random
 * one) keeps regeneration byte-identical; Postman treats `_postman_id` as the
 * local collection identity and happily imports a fixed value.
 */
const STABLE_POSTMAN_ID = '00000000-0000-0000-0000-000000000000';

/** Field names the converter fills with non-deterministic values. */
const VOLATILE_FIELDS = new Set(['id', 'response', '_postman_id']);

const writeMode = process.argv.includes('--write');

/**
 * Recursively removes fields the converter fills with run-specific values:
 * random item UUIDs (`id`) and faker-generated response examples (`response`).
 * Mutates and returns `node`.
 */
function stripVolatileFields(node) {
  if (Array.isArray(node)) {
    node.forEach(stripVolatileFields);
    return node;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (VOLATILE_FIELDS.has(key)) {
        delete node[key];
        continue;
      }
      stripVolatileFields(node[key]);
    }
  }
  return node;
}

/**
 * Produces the deterministic representation of a converted collection: volatile
 * fields stripped and `info._postman_id` pinned. Returns the same object.
 */
function normalizeCollection(collection) {
  stripVolatileFields(collection);
  if (!collection.info || typeof collection.info !== 'object') {
    collection.info = {};
  }
  collection.info._postman_id = STABLE_POSTMAN_ID;
  return collection;
}

/**
 * Reduces a Postman collection's items into a stable ordered structure
 * signature (folder labels and `{ name, method, url }` request descriptors).
 * Only used to render a focused drift message when the byte compare fails.
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
 * Converts the OpenAPI spec at SPEC_PATH into a normalized, deterministic
 * Postman collection. Resolves with the collection object.
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
      // `schemaFaker: false` keeps request bodies free of random faker values;
      // response examples are stripped entirely by normalizeCollection().
      { schemaFaker: false, requestNameSource: 'Fallback' },
      (err, conversionResult) => {
        if (err) return reject(err);
        if (!conversionResult || !conversionResult.result) {
          return reject(new Error(conversionResult?.reason || 'OpenAPI → Postman conversion failed'));
        }
        const collection = (conversionResult.output || []).find((o) => o.type === 'collection')?.data;
        if (!collection) {
          return reject(new Error('Postman collection missing from conversion output'));
        }
        resolve(normalizeCollection(collection));
      },
    );
  });
}

/** Canonical serialization used for both `--write` and the freshness compare. */
function canonicalize(collection) {
  return `${JSON.stringify(collection, null, 2)}\n`;
}

async function main() {
  let generated;
  try {
    generated = await convertSpecToCollection();
  } catch (error) {
    console.error('[verify-postman-sync] Failed to generate Postman collection:', error.message);
    process.exit(1);
  }

  const generatedText = canonicalize(generated);

  if (writeMode) {
    fs.mkdirSync(path.dirname(COLLECTION_PATH), { recursive: true });
    fs.writeFileSync(COLLECTION_PATH, generatedText, 'utf-8');
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

  const committedText = fs.readFileSync(COLLECTION_PATH, 'utf-8');

  if (generatedText === committedText) {
    console.log('[verify-postman-sync] Postman collection is in sync with the OpenAPI spec: OK');
    return;
  }

  // Byte compare failed: report whether the API surface itself drifted or the
  // committed file just carries converter noise.
  let structuralNote =
    '  The committed artifact matches the current API surface but is not the\n' +
    '  deterministic output (e.g. it still contains converter UUIDs or faker\n' +
    '  response bodies).\n';
  try {
    const committed = JSON.parse(committedText);
    const generatedSig = JSON.stringify(structureSignature(generated.item), null, 2);
    const committedSig = JSON.stringify(structureSignature(committed.item), null, 2);
    if (generatedSig !== committedSig) {
      structuralNote =
        '  The request structure of docs/postman-collection.json no longer matches\n' +
        '  the current docs/openapi.json (a folder, request, HTTP method, or URL was\n' +
        '  added, removed, or changed).\n';
    }
  } catch {
    structuralNote = '  The committed artifact is not valid JSON.\n';
  }

  console.error(
    '\n[verify-postman-sync] POSTMAN COLLECTION DRIFT DETECTED\n',
    '\n' + structuralNote,
    '\n  To fix, regenerate and commit the refreshed collection:\n' +
      '    npm run docs:generate   # writes docs/openapi.json + docs/postman-collection.json\n' +
      '    git add docs/postman-collection.json && git commit\n' +
      '\n  Keeping these in lockstep prevents consumers of the published collection\n' +
      '  from relying on stale request/response contracts.\n',
  );
  process.exit(1);
}

main();
