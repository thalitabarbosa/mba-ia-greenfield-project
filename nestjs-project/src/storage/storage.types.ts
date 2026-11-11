export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export type UrlAudience = 'public' | 'internal';

export interface PresignGetOptions {
  /** `public` for URLs handed to clients, `internal` for URLs consumed inside Docker. */
  audience: UrlAudience;
  /** When set, the response carries `Content-Disposition: attachment`. */
  downloadFileName?: string;
}
