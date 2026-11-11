import { registerAs } from '@nestjs/config';

export default registerAs('upload', () => ({
  maxFileSize: parseInt(process.env.UPLOAD_MAX_FILE_SIZE || '10737418240', 10),
  partSize: parseInt(process.env.UPLOAD_PART_SIZE || '67108864', 10),
}));
