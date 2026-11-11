import { buildDownloadFileName } from './download-file-name.util';

describe('buildDownloadFileName', () => {
  it('keeps safe titles and appends the original extension', () => {
    expect(buildDownloadFileName('My video', 'clip.MP4')).toBe('My video.MP4');
  });

  it('strips accents and replaces header-unsafe characters', () => {
    expect(buildDownloadFileName('Ação "ao vivo"/1', 'a.mp4')).toBe(
      'Acao _ao vivo__1.mp4',
    );
  });

  it('falls back to "video" when nothing is left', () => {
    expect(buildDownloadFileName('   ', 'a.webm')).toBe('video.webm');
  });
});
