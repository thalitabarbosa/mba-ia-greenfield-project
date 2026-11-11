import { planParts } from './upload-plan.util';

const MIB = 1024 * 1024;

describe('planParts', () => {
  it('splits 10 GiB into 160 parts of 64 MiB', () => {
    expect(planParts(10 * 1024 * MIB, 64 * MIB)).toEqual({
      partSize: 64 * MIB,
      partCount: 160,
    });
  });

  it('adds a final part for the remainder', () => {
    expect(planParts(64 * MIB + 1, 64 * MIB).partCount).toBe(2);
  });

  it('uses a single part for a 1-byte file', () => {
    expect(planParts(1, 64 * MIB).partCount).toBe(1);
  });

  it('rejects plans above 10,000 parts', () => {
    expect(() => planParts(10_001 * 5 * MIB, 5 * MIB)).toThrow(RangeError);
  });

  it('rejects non-positive sizes', () => {
    expect(() => planParts(0, 5 * MIB)).toThrow(RangeError);
  });
});
