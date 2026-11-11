import { IsIn, IsInt, IsString, Length, Max, Min } from 'class-validator';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  MAX_VIDEO_FILE_SIZE,
} from '../videos.constants';

export class InitiateUploadDto {
  /** Video title. @example "Minha primeira live" */
  @IsString()
  @Length(1, 100)
  title: string;

  /** Original file name on the client. @example "live.mp4" */
  @IsString()
  @Length(1, 255)
  fileName: string;

  /** Exact file size in bytes (max 10 GiB). @example 734003200 */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_FILE_SIZE)
  fileSize: number;

  /** MIME type of the file. @example "video/mp4" */
  @IsString()
  @IsIn([...ALLOWED_VIDEO_CONTENT_TYPES])
  contentType: string;
}
