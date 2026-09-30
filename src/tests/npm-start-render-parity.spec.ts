import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const renderYaml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

function resolveEntrypoint(command: string): string {
  const npmRunMatch = command.match(/^npm run ([\w:]+)$/);
  if (npmRunMatch) {
    return resolveEntrypoint(pkg.scripts[npmRunMatch[1]]);
  }
  if (command === 'npm start') {
    return resolveEntrypoint(pkg.scripts.start);
  }
  return command;
}

function parseRenderServices(yaml: string): Record<string, string> {
  const blocks = yaml.split(/\n(?= {2}- type: web)/).filter(block => block.includes('type: web'));
  const services: Record<string, string> = {};

  for (const block of blocks) {
    const nameMatch = block.match(/\n\s*name:\s*(\S+)/);
    const startMatch = block.match(/\n\s*startCommand:\s*(.+)/);
    if (nameMatch && startMatch) {
      services[nameMatch[1]] = startMatch[1].trim();
    }
  }

  return services;
}

describe('npm start / Render command parity (#386)', () => {
  describe('package.json scripts', () => {
    it('points "start" at the production full-backend entrypoint (dist/index.js)', () => {
      expect(pkg.scripts.start).toBe('node dist/index.js');
    });

    it('exposes an explicit "start:full" alias identical to "start"', () => {
      expect(pkg.scripts['start:full']).toBe(pkg.scripts.start);
      expect(pkg.scripts['start:full']).toBe('node dist/index.js');
    });

    it('exposes an explicit "start:hackathon" script for the demo entrypoint (dist/server.js)', () => {
      expect(pkg.scripts['start:hackathon']).toBe('node dist/server.js');
    });

    it('sets "main" to the same entrypoint "start" boots', () => {
      expect(pkg.main).toBe('dist/index.js');
    });
  });

  describe('render.yaml', () => {
    const services = parseRenderServices(renderYaml);

    it('declares both the hackathon and production service profiles', () => {
      expect(Object.keys(services).sort()).toEqual(['xelma-backend', 'xelma-backend-hackathon']);
    });

    it('boots the hackathon profile via the hackathon npm script (dist/server.js)', () => {
      const command = services['xelma-backend-hackathon'];
      expect(resolveEntrypoint(command)).toBe('node dist/server.js');
    });

    it('boots the production profile via "npm start" (dist/index.js)', () => {
      const command = services['xelma-backend'];
      expect(command).toBe('npm start');
      expect(resolveEntrypoint(command)).toBe('node dist/index.js');
    });
  });

  describe('README documentation', () => {
    it('documents the start, start:full, and start:hackathon scripts in the Scripts table', () => {
      expect(readme).toMatch(/\|\s*`npm start`.*dist\/index\.js/);
      expect(readme).toContain('`npm run start:full`');
      expect(readme).toContain('`npm run start:hackathon`');
    });

    it('documents the correct Render start command per profile', () => {
      expect(readme).toContain('`npm run start:hackathon` (runs `dist/server.js`)');
      expect(readme).toContain('`npm start` (runs `dist/index.js`)');
    });
  });
});
