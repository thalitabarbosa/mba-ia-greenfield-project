import { parseFrameRate, parseProbeOutput } from './ffprobe.parser';
import { MediaProcessingError } from './media-processing.error';

const sample = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30000/1001',
      duration: '12.5',
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '12.512000',
    bit_rate: '4500000',
    size: '7038000',
  },
};

describe('parseProbeOutput', () => {
  it('maps ffprobe JSON to the curated metadata shape', () => {
    expect(parseProbeOutput(sample)).toEqual({
      durationSeconds: 12.512,
      metadata: {
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        bitRate: 4500000,
        frameRate: 29.97,
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        sizeBytes: 7038000,
      },
    });
  });

  it('accepts videos without audio and falls back to the stream duration', () => {
    const result = parseProbeOutput({
      streams: [sample.streams[0]],
      format: { format_name: 'webm' },
    });
    expect(result.metadata.audioCodec).toBeNull();
    expect(result.durationSeconds).toBe(12.5);
  });

  it('throws NO_VIDEO_STREAM when there is no video stream', () => {
    expect(() =>
      parseProbeOutput({ streams: [{ codec_type: 'audio' }], format: {} }),
    ).toThrow(new MediaProcessingError('NO_VIDEO_STREAM'));
  });
});

describe('parseFrameRate', () => {
  it.each([
    ['25/1', 25],
    ['30000/1001', 29.97],
    ['0/0', null],
    [undefined, null],
  ])('parses %s as %s', (input, expected) => {
    expect(parseFrameRate(input)).toBe(expected);
  });
});
