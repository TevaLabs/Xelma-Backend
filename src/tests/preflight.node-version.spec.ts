import { runPreflightChecks } from '../config/preflight';

describe('Preflight – node version enforcement (#540)', () => {
  const originalVersion = process.version;

  afterEach(() => {
    Object.defineProperty(process, 'version', { value: originalVersion, configurable: true });
  });

  it('passes when Node version is >= 22', () => {
    Object.defineProperty(process, 'version', { value: 'v22.5.0', configurable: true });
    const result = runPreflightChecks({ JWT_SECRET: 'a'.repeat(20), NODE_ENV: 'test' });
    const nodeErrors = result.errors.filter(e => e.includes('Node.js'));
    expect(nodeErrors).toHaveLength(0);
  });

  it('fails when Node version is below 22', () => {
    Object.defineProperty(process, 'version', { value: 'v20.10.0', configurable: true });
    const result = runPreflightChecks({ JWT_SECRET: 'a'.repeat(20), NODE_ENV: 'test' });
    const nodeErrors = result.errors.filter(e => e.includes('Node.js'));
    expect(nodeErrors.length).toBeGreaterThan(0);
    expect(nodeErrors[0]).toContain('v20.10.0');
  });

  it('fails when Node version is 18.x', () => {
    Object.defineProperty(process, 'version', { value: 'v18.19.0', configurable: true });
    const result = runPreflightChecks({ JWT_SECRET: 'a'.repeat(20), NODE_ENV: 'test' });
    const nodeErrors = result.errors.filter(e => e.includes('Node.js'));
    expect(nodeErrors.length).toBeGreaterThan(0);
  });

  it('fails when Node version is unparseable', () => {
    Object.defineProperty(process, 'version', { value: 'vx.y.z', configurable: true });
    const result = runPreflightChecks({ JWT_SECRET: 'a'.repeat(20), NODE_ENV: 'test' });
    const nodeErrors = result.errors.filter(e => e.includes('Node.js'));
    expect(nodeErrors.length).toBeGreaterThan(0);
  });
});
