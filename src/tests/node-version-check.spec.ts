import { execSync } from 'child_process';
import path from 'path';

describe('Node version startup check', () => {
  it('exits with code 1 and an error message if Node.js version is below 22', () => {
    try {
      execSync('npx -y -p node@18 node dist/index.js', {
        cwd: path.resolve(__dirname, '../../'),
        stdio: 'pipe',
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.status).toBe(1);
      const stderr = error.stderr.toString();
      expect(stderr).toContain('Node.js v22.x or higher is required');
      expect(stderr).toContain('Application startup failed');
    }
  });
});
