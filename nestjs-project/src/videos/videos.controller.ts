import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import {
  InitiateUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

/** All routes are owner-only in Phase 03 (TD-09) — no @Public(). */
@ApiTags('videos')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Missing or invalid access token', schema: errorSchema })
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as draft and returns one presigned URL per part. The client PUTs each part directly to storage.',
  })
  @ApiResponse({ status: 201, type: InitiateUploadResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed', schema: errorSchema })
  @ApiResponse({ status: 404, description: 'CHANNEL_NOT_FOUND', schema: errorSchema })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Assembles the uploaded parts, verifies the size and enqueues processing.',
  })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse({ status: 404, description: 'VIDEO_NOT_FOUND', schema: errorSchema })
  @ApiResponse({ status: 409, description: 'VIDEO_INVALID_STATUS', schema: errorSchema })
  @ApiResponse({
    status: 422,
    description: 'UPLOAD_PARTS_INVALID | UPLOAD_SIZE_MISMATCH',
    schema: errorSchema,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Abort a draft upload' })
  @ApiResponse({ status: 204, description: 'Upload aborted and draft removed' })
  @ApiResponse({ status: 404, description: 'VIDEO_NOT_FOUND', schema: errorSchema })
  @ApiResponse({ status: 409, description: 'VIDEO_INVALID_STATUS', schema: errorSchema })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, id);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a video by its unique slug' })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse({ status: 404, description: 'VIDEO_NOT_FOUND', schema: errorSchema })
  async getBySlug(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getDetails(user.sub, slug);
  }

  @Get(':slug/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a short-lived storage URL that supports HTTP Range (206 Partial Content).',
  })
  @ApiResponse({ status: 302, description: 'Location: presigned storage URL' })
  @ApiResponse({ status: 409, description: 'VIDEO_NOT_READY', schema: errorSchema })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<{ url: string }> {
    return { url: await this.videosService.getStreamUrl(user.sub, slug) };
  }

  @Get(':slug/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects (302) to a short-lived storage URL served with Content-Disposition: attachment.',
  })
  @ApiResponse({ status: 302, description: 'Location: presigned storage URL' })
  @ApiResponse({ status: 409, description: 'VIDEO_NOT_READY', schema: errorSchema })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<{ url: string }> {
    return { url: await this.videosService.getDownloadUrl(user.sub, slug) };
  }

  @Get(':slug/thumbnail')
  @Redirect()
  @ApiOperation({ summary: 'Get the generated thumbnail (302 to storage)' })
  @ApiResponse({ status: 302, description: 'Location: presigned storage URL' })
  @ApiResponse({ status: 404, description: 'THUMBNAIL_NOT_FOUND', schema: errorSchema })
  async thumbnail(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<{ url: string }> {
    return { url: await this.videosService.getThumbnailUrl(user.sub, slug) };
  }
}
