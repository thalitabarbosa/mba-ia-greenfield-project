import { videoOriginalKey, videoThumbnailKey } from './storage-keys';

describe('storage keys', () => {
  it('derives the original video key from the video id', () => {
    expect(videoOriginalKey('abc')).toBe('videos/abc/original');
  });

  it('derives the thumbnail key from the video id', () => {
    expect(videoThumbnailKey('abc')).toBe('thumbnails/abc/thumbnail.jpg');
  });
});
