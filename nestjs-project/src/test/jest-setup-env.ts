// Tests run inside the nestjs-api container, where the public MinIO endpoint
// (http://localhost:9000) is unreachable. Presigned URLs used by tests must be
// signed for the Compose host instead (TD-02 R1).
process.env.S3_PUBLIC_ENDPOINT =
  process.env.S3_TEST_PUBLIC_ENDPOINT ?? 'http://minio:9000';
