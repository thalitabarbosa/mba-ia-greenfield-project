import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { UploadPartsInvalidException } from '../common/exceptions/domain.exception';
import {
  INVALID_PARTS_ERROR_CODES,
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PUBLIC_CLIENT,
} from './storage.constants';
import type {
  CompletedPart,
  PresignGetOptions,
  UrlAudience,
} from './storage.types';

@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(STORAGE_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  get presignedUrlExpirationSeconds(): number {
    return this.config.presignedUrlExpirationSeconds;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error(`Storage returned no UploadId for key ${key}`);
    }
    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.presignedUrlExpirationSeconds },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sorted.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
            })),
          },
        }),
      );
    } catch (err) {
      if (this.isInvalidPartsError(err)) {
        throw new UploadPartsInvalidException();
      }
      throw err;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      // Aborting an upload that no longer exists is the desired end state.
      if (err instanceof S3ServiceException && err.name === 'NoSuchUpload') {
        return;
      }
      throw err;
    }
  }

  async getObjectSize(key: string): Promise<number> {
    const head = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return head.ContentLength ?? 0;
  }

  async presignGetObject(
    key: string,
    options: PresignGetOptions,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ...(options.downloadFileName && {
        ResponseContentDisposition: `attachment; filename="${options.downloadFileName}"`,
      }),
    });
    return getSignedUrl(this.clientFor(options.audience), command, {
      expiresIn: this.config.presignedUrlExpirationSeconds,
    });
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  private clientFor(audience: UrlAudience): S3Client {
    return audience === 'public' ? this.publicClient : this.internalClient;
  }

  private isInvalidPartsError(err: unknown): boolean {
    return (
      err instanceof S3ServiceException &&
      INVALID_PARTS_ERROR_CODES.includes(err.name)
    );
  }
}
