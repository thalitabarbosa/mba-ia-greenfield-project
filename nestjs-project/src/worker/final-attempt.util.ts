/**
 * During `process()`, BullMQ's `attemptsMade` counts the attempts that
 * already failed, so the running attempt is the last one when
 * `attemptsMade + 1 >= attempts`.
 */
export function isFinalAttempt(
  attemptsMade: number,
  attempts: number | undefined,
): boolean {
  return attemptsMade + 1 >= (attempts ?? 1);
}
