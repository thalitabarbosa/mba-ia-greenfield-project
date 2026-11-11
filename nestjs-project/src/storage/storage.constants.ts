export const STORAGE_INTERNAL_CLIENT = 'STORAGE_INTERNAL_CLIENT';
export const STORAGE_PUBLIC_CLIENT = 'STORAGE_PUBLIC_CLIENT';

/** S3 error codes returned by CompleteMultipartUpload when parts are unusable. */
export const INVALID_PARTS_ERROR_CODES = [
  'NoSuchUpload',
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
];
