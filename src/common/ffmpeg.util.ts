import * as fs from 'fs';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegStatic from 'ffmpeg-static';
import * as ffprobeStatic from 'ffprobe-static';

let isConfigured = false;

export function configureFfmpeg(): void {
  if (isConfigured) return;

  let ffmpegPath = process.env.FFMPEG_PATH;
  if (!ffmpegPath) {
    if (fs.existsSync('/usr/bin/ffmpeg')) {
      ffmpegPath = '/usr/bin/ffmpeg';
    } else if (fs.existsSync('/usr/local/bin/ffmpeg')) {
      ffmpegPath = '/usr/local/bin/ffmpeg';
    } else {
      ffmpegPath = typeof ffmpegStatic === 'string' ? ffmpegStatic : (ffmpegStatic as any)?.default || ffmpegStatic;
    }
  }

  let ffprobePath = process.env.FFPROBE_PATH;
  if (!ffprobePath) {
    if (fs.existsSync('/usr/bin/ffprobe')) {
      ffprobePath = '/usr/bin/ffprobe';
    } else if (fs.existsSync('/usr/local/bin/ffprobe')) {
      ffprobePath = '/usr/local/bin/ffprobe';
    } else {
      ffprobePath = typeof ffprobeStatic === 'string' ? ffprobeStatic : (ffprobeStatic as any)?.path || (ffprobeStatic as any)?.default?.path || ffprobeStatic;
    }
  }

  if (ffmpegPath) {
    console.log(`[FFMPEG] Using binary path: ${ffmpegPath}`);
    ffmpeg.setFfmpegPath(String(ffmpegPath));
  }
  if (ffprobePath) {
    console.log(`[FFPROBE] Using binary path: ${ffprobePath}`);
    ffmpeg.setFfprobePath(String(ffprobePath));
  }

  isConfigured = true;
}

export function probeDuration(filePath: string, timeoutMs: number = 5000): Promise<number> {
  configureFfmpeg();
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn(`[probeDuration] Timed out after ${timeoutMs}ms for ${filePath}`);
        resolve(0);
      }
    }, timeoutMs);

    try {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (err) {
            console.error('[probeDuration] Error probing duration:', err?.message || err);
            return resolve(0);
          }
          const duration = metadata?.format?.duration;
          resolve(duration ? Number(duration) : 0);
        }
      });
    } catch (err: any) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        console.error('[probeDuration] Exception probing duration:', err?.message || err);
        resolve(0);
      }
    }
  });
}
