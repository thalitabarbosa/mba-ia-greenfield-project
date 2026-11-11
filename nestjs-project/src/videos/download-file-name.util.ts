import { extname } from 'node:path';

/** Header-safe download name: sanitized title + original extension. */
export function buildDownloadFileName(
  title: string,
  originalFileName: string,
): string {
  const base =
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._ -]/g, '_')
      .trim() || 'video';
  const ext = extname(originalFileName).replace(/[^A-Za-z0-9.]/g, '');
  return `${base}${ext}`;
}
