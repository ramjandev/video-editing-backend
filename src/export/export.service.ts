import { Injectable, BadRequestException } from '@nestjs/common';
import * as express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import * as fs from 'fs';
import * as path from 'path';

// Configure FFMPEG paths
ffmpeg.setFfmpegPath(ffmpegStatic!);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const WEIGHTS: Record<string, number> = {
  image: 1.0,
  audio: 1.2,
  text: 1.5,
  textAnim: 2.5,
  layout: 2.0,
  video: 4.0,
};

const RESOLUTION_MULTIPLIERS: Record<string, number> = {
  '480p': 0.5,
  '720p': 1.0,
  '1080p': 1.8,
  '4k': 4.0,
};

@Injectable()
export class ExportService {
  private probeHasAudio(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(url, (err, metadata) => {
        if (err) {
          console.error('FFPROBE Error on URL:', url, err.message);
          resolve(false);
        } else if (!metadata || !metadata.streams) {
          resolve(false);
        } else {
          resolve(metadata.streams.some((s) => s.codec_type === 'audio'));
        }
      });
    });
  }

  private getResKey(sceneGraph: any): string {
    let resKey = '720p';
    if (sceneGraph.resolution) {
      const width = sceneGraph.resolution.w;
      const height = sceneGraph.resolution.h;
      if (width >= 3840 || height >= 2160) resKey = '4k';
      else if (width >= 1920 || height >= 1080) resKey = '1080p';
      else if (width >= 1280 || height >= 720) resKey = '720p';
      else resKey = '480p';
    }
    return resKey;
  }

  private calculateTotalProjectWorkload(sceneGraph: any): number {
    if (!sceneGraph || !sceneGraph.tracks) return 0;
    let totalTCU = 0;
    const resMult = RESOLUTION_MULTIPLIERS[this.getResKey(sceneGraph)] || 1.0;

    sceneGraph.tracks.forEach((track: any) => {
      const clips = track.clips || [];
      clips.forEach((clip: any) => {
        const type = clip.asset?.type || track.type || 'video';
        const baseWeight = WEIGHTS[type] ?? WEIGHTS.image;
        const duration = (clip.trimOut - clip.trimIn) || (clip.endTime - clip.startTime) || 0;
        const multiplier = type === 'video' ? resMult : 1.0;
        totalTCU += duration * baseWeight * multiplier;
      });
    });
    return totalTCU;
  }

  private createRenderSession(totalTCU: number) {
    return {
      totalTCU,
      processedTCU: 0,
      smoothedSpeed: null as number | null,
      renderStartTime: Date.now(),
      lastUpdateTime: Date.now(),
      warmupMs: 5000,
      alpha: 0.3,
    };
  }

  private parseTimemark(timemark: string): number {
    if (!timemark) return 0;
    const parts = timemark.split(':');
    if (parts.length !== 3) return 0;
    return (parseFloat(parts[0]) || 0) * 3600 + (parseFloat(parts[1]) || 0) * 60 + (parseFloat(parts[2]) || 0);
  }

  private calculateProcessedTCU(sceneGraph: any, t: number): number {
    if (!sceneGraph || !sceneGraph.tracks) return 0;
    let processed = 0;
    const resMult = RESOLUTION_MULTIPLIERS[this.getResKey(sceneGraph)] || 1.0;

    sceneGraph.tracks.forEach((track: any) => {
      const clips = track.clips || [];
      clips.forEach((clip: any) => {
        const type = clip.asset?.type || track.type || 'video';
        const baseWeight = WEIGHTS[type] ?? WEIGHTS.image;
        const multiplier = type === 'video' ? resMult : 1.0;
        const clipStart = clip.startTime || 0;
        const clipEnd = clip.endTime || 0;
        const activeDuration = Math.max(0, Math.min(t - clipStart, clipEnd - clipStart));
        processed += activeDuration * baseWeight * multiplier;
      });
    });
    return processed;
  }

  async export(sceneGraph: any, res: express.Response, requestOrigin: string) {
    // Dump to file for debug
    fs.writeFileSync(
      path.join(process.cwd(), 'last_export.json'),
      JSON.stringify(sceneGraph, null, 2),
    );

    if (!sceneGraph || !sceneGraph.tracks || sceneGraph.tracks.length === 0) {
      throw new BadRequestException('Empty scene graph');
    }

    const allClipsInProject: any[] = [];
    sceneGraph.tracks.forEach((track: any) => {
      if (track.clips) allClipsInProject.push(...track.clips);
    });

    const mainClips = allClipsInProject
      .filter((clip) => {
        const type = clip.asset?.type || 'video';
        return (type === 'video' || type === 'image') && (clip.asset?.preview_url || clip.asset?.original_url);
      })
      .sort((a, b) => a.startTime - b.startTime);

    const audioClips = allClipsInProject
      .filter((clip) => clip.asset?.type === 'audio' && (clip.asset?.preview_url || clip.asset?.original_url))
      .sort((a, b) => a.startTime - b.startTime);

    if (mainClips.length === 0) {
      throw new BadRequestException('No video clips to export');
    }

    const outputPath = path.join(process.cwd(), 'uploads', `export_${Date.now()}.mp4`);
    if (!fs.existsSync(path.join(process.cwd(), 'uploads'))) {
      fs.mkdirSync(path.join(process.cwd(), 'uploads'), { recursive: true });
    }

    const allClips = [...mainClips, ...audioClips];
    const hasAudioFlags = await Promise.all(
      allClips.map((clip) => this.probeHasAudio(clip.asset.preview_url || clip.asset.original_url)),
    );

    const command = ffmpeg();
    allClips.forEach((clip) => {
      command.input(clip.asset.preview_url || clip.asset.original_url);
    });

    let filter = '';

    // 1. Process Main Video Track
    if (mainClips.length === 1) {
      const clip = mainClips[0];
      filter += `[0:v]trim=start=${Math.max(0, clip.trimIn)}:end=${Math.max(0, clip.trimOut)},setpts=PTS-STARTPTS,scale=1280:720,setsar=1,fps=30,format=yuv420p[outv]; `;
      if (hasAudioFlags[0]) {
        filter += `[0:a]atrim=start=${Math.max(0, clip.trimIn)}:end=${Math.max(0, clip.trimOut)},asetpts=PTS-STARTPTS[main_a]; `;
      } else {
        const duration = Math.max(0.1, clip.trimOut - clip.trimIn);
        filter += `anullsrc=r=44100:cl=stereo:d=${duration}[main_a]; `;
      }
    } else {
      mainClips.forEach((clip, index) => {
        filter += `[${index}:v]trim=start=${Math.max(0, clip.trimIn)}:end=${Math.max(0, clip.trimOut)},setpts=PTS-STARTPTS,scale=1280:720,setsar=1,fps=30,format=yuv420p[v${index}]; `;
        if (hasAudioFlags[index]) {
          filter += `[${index}:a]atrim=start=${Math.max(0, clip.trimIn)}:end=${Math.max(0, clip.trimOut)},asetpts=PTS-STARTPTS[a${index}]; `;
        } else {
          const duration = Math.max(0.1, clip.trimOut - clip.trimIn);
          filter += `anullsrc=r=44100:cl=stereo:d=${duration}[a${index}]; `;
        }
      });
      const concatInputs = mainClips.map((_, i) => `[v${i}][a${i}]`).join('');
      filter += `${concatInputs}concat=n=${mainClips.length}:v=1:a=1[outv][main_a]; `;
    }

    // 2. Process Audio Track
    let mixAudioInputs = '[main_a]';
    let numAudioInputs = 1;

    audioClips.forEach((clip, i) => {
      const index = mainClips.length + i;
      if (!hasAudioFlags[index]) return;
      const delayMs = Math.floor(clip.startTime * 1000);
      filter += `[${index}:a]atrim=start=${Math.max(0, clip.trimIn)}:end=${Math.max(0, clip.trimOut)},asetpts=PTS-STARTPTS,adelay=delays=${delayMs}:all=1[aud${i}]; `;
      mixAudioInputs += `[aud${i}]`;
      numAudioInputs++;
    });

    if (numAudioInputs > 1) {
      filter += `${mixAudioInputs}amix=inputs=${numAudioInputs}:duration=first:dropout_transition=2:normalize=0[outa]`;
      command.complexFilter(filter, ['outv', 'outa']);
    } else {
      command.complexFilter(filter, ['outv', 'main_a']);
    }

    command.videoCodec('libx264').audioCodec('aac').outputOptions(['-shortest']);

    const totalTCU = this.calculateTotalProjectWorkload(sceneGraph);
    const session = this.createRenderSession(totalTCU);

    command.on('progress', (progress) => {
      const currentTime = Date.now();
      const elapsedMs = currentTime - session.renderStartTime;
      const batchDurationSeconds = (currentTime - session.lastUpdateTime) / 1000;
      session.lastUpdateTime = currentTime;

      let t = 0;
      if (progress.timemark) {
        t = this.parseTimemark(progress.timemark);
      } else if (progress.percent && sceneGraph.duration) {
        t = sceneGraph.duration * (progress.percent / 100);
      }

      const currentProcessedTCU = this.calculateProcessedTCU(sceneGraph, t);
      const unitsCompletedInBatch = Math.max(0, currentProcessedTCU - session.processedTCU);
      session.processedTCU = Math.min(session.totalTCU, currentProcessedTCU);

      const progressPercent = session.totalTCU > 0
        ? (session.processedTCU / session.totalTCU) * 100
        : (progress.percent || 0);
      const percent = Math.min(99, Math.max(0, Math.round(progressPercent)));

      if (elapsedMs < session.warmupMs) {
        res.write(`data: ${JSON.stringify({ type: 'progress', percent, etaSeconds: null, status: 'preparing' })}\n\n`);
        return;
      }

      const batchSpeed = batchDurationSeconds > 0 ? unitsCompletedInBatch / batchDurationSeconds : 0;
      if (session.smoothedSpeed === null) {
        session.smoothedSpeed = batchSpeed > 0 ? batchSpeed : 1.0;
      } else {
        session.smoothedSpeed = session.alpha * batchSpeed + (1 - session.alpha) * session.smoothedSpeed;
      }

      const remainingTCU = Math.max(0, session.totalTCU - session.processedTCU);
      let etaSeconds: number | null = null;
      if (session.smoothedSpeed > 0.001) {
        etaSeconds = Math.ceil(remainingTCU / session.smoothedSpeed);
      }

      res.write(`data: ${JSON.stringify({ type: 'progress', percent, etaSeconds, status: 'rendering' })}\n\n`);
    });

    command.on('end', () => {
      const filename = path.basename(outputPath);
      res.write(`data: ${JSON.stringify({ type: 'complete', url: `${requestOrigin}/uploads/${filename}` })}\n\n`);
      res.end();
    });

    command.on('error', (err: any, stdout: string, stderr: string) => {
      console.error('Export error:', err);
      console.error('FFmpeg stderr:', stderr);
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message + ' | stderr: ' + (stderr || '').slice(-200) })}\n\n`);
      res.end();
    });

    command.save(outputPath);
  }
}
