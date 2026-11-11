import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_MULTIPART_PARTS } from '../videos.constants';

export class CompletedPartDto {
  /** 1-based part number. @example 1 */
  @IsInt()
  @Min(1)
  @Max(MAX_MULTIPART_PARTS)
  partNumber: number;

  /** ETag header returned by storage for the part PUT. @example "\"9b2cf535f27731c974343645a3985328\"" */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MULTIPART_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
