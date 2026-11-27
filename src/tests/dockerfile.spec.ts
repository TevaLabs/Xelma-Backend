import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..', '..');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8').replace(/\r\n/g, '\n');

function stage(name: string): string {
  const parts = dockerfile.split(/^FROM /m).slice(1);
  const found = parts.find((part) =>
    new RegExp(`\\bAS ${name}\\b`, 'i').test(part.split('\n')[0] ?? ''),
  );
  if (!found) {
    throw new Error(`Dockerfile stage "${name}" not found`);
  }
  return found;
}

function ignorePatterns(): string[] {
  return dockerignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('Dockerfile keeps the runtime image lean (Issue #1049)', () => {
  it('installs only production dependencies in the runner stage', () => {
    const runner = stage('runner');
    const installs = runner.split('\n').filter((line) => /\bnpm ci\b/.test(line));
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) {
      expect(line).toContain('--omit=dev');
    }
  });

  it('never copies a whole node_modules tree from an earlier stage into the runner', () => {
    const runner = stage('runner');
    expect(runner).not.toMatch(/COPY\s+--from=\S+\s+\/app\/node_modules\/?\s/);
  });

  it('does not build or run the test suite in the runner stage', () => {
    const runner = stage('runner');
    expect(runner).not.toMatch(/npm run build/);
    expect(runner).not.toMatch(/npm (run )?test/);
  });

  it('keeps devDependencies available to the build stage', () => {
    const deps = stage('deps');
    expect(deps).toMatch(/npm ci/);
    expect(deps).not.toContain('--omit=dev');
  });

  it('cleans the npm cache after the production install', () => {
    expect(stage('runner')).toContain('npm cache clean --force');
  });
});

describe('.dockerignore (Issue #1049)', () => {
  it('excludes local state that must not reach the image', () => {
    const patterns = ignorePatterns();
    for (const expected of ['node_modules', 'dist', '.git', '.env', '.env.*']) {
      expect(patterns).toContain(expected);
    }
  });

  it('does not exclude anything the Dockerfile copies from the build context', () => {
    const patterns = ignorePatterns();
    const sources = dockerfile
      .split('\n')
      .map((line) => /^COPY\s+(?!--from)(\S+)\s+\S+/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1] as string);

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const top = source.replace(/^\.\//, '').split('/')[0] as string;
      for (const candidate of [source, top, `${top}/`, `/${top}`]) {
        expect(patterns).not.toContain(candidate);
      }
    }
  });
});
