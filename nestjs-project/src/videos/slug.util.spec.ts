import { generateVideoSlug } from './slug.util';

describe('generateVideoSlug', () => {
  it('returns 11 URL-safe characters', () => {
    expect(generateVideoSlug()).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('does not repeat across 10k generations', () => {
    const slugs = new Set(
      Array.from({ length: 10_000 }, () => generateVideoSlug()),
    );
    expect(slugs.size).toBe(10_000);
  });
});
