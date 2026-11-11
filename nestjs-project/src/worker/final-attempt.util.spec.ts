import { isFinalAttempt } from './final-attempt.util';

describe('isFinalAttempt', () => {
  it.each([
    [0, 3, false],
    [1, 3, false],
    [2, 3, true],
    [0, undefined, true],
  ])('attemptsMade=%s attempts=%s → %s', (made, attempts, expected) => {
    expect(isFinalAttempt(made, attempts)).toBe(expected);
  });
});
