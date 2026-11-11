import { randomBytes } from 'node:crypto';

/** 8 random bytes → 11 base64url chars (`[A-Za-z0-9_-]`), TD-06. */
export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url');
}
