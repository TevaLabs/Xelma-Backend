import { describe, expect, it } from '@jest/globals';
import { updateProfileSchema } from '../schemas/user.schema';

describe('updateProfileSchema avatarUrl', () => {
  it.each([
    ['javascript scheme', 'javascript:alert(1)'],
    ['HTTP scheme', 'http://cdn.example.com/avatar.png'],
    ['link-local metadata IP', 'https://169.254.169.254/latest/meta-data/'],
    ['private 10/8 IP', 'https://10.0.0.1/avatar.png'],
    ['private 172.16/12 IP', 'https://172.16.0.1/avatar.png'],
    ['private 192.168/16 IP', 'https://192.168.1.1/avatar.png'],
    ['internal metadata hostname', 'https://metadata.google.internal/computeMetadata/v1/'],
    ['trailing-dot metadata hostname', 'https://metadata.google.internal./computeMetadata/v1/'],
  ])('rejects %s with a validation issue', (_description, avatarUrl) => {
    const result = updateProfileSchema.safeParse({ avatarUrl });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues[0].path).toEqual(['avatarUrl']);
    }
  });

  it('accepts a valid HTTPS CDN URL', () => {
    const result = updateProfileSchema.safeParse({
      avatarUrl: 'https://cdn.example.com/avatar.png',
    });

    expect(result.success).toBe(true);
  });
});