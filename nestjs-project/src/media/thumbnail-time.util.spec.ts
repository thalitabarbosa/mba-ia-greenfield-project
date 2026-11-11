import { thumbnailTimestamp } from './thumbnail-time.util';

describe('thumbnailTimestamp', () => {
  it.each([
    [null, 0],
    [0.5, 0],
    [30, 3],
    [600, 10],
  ])('duration %s → %s s', (duration, expected) => {
    expect(thumbnailTimestamp(duration)).toBe(expected);
  });
});
