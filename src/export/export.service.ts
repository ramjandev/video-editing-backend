import { Injectable, BadRequestException } from '@nestjs/common';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { configureFfmpeg } from '../common/ffmpeg.util';
import { PrismaService } from '../prisma/prisma.service';

// Configure FFMPEG paths
configureFfmpeg();

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
  constructor(private prisma: PrismaService) {}
  private resolveLocalFilePath(rawUrl: string): string {
    if (!rawUrl) return rawUrl;
    if (rawUrl.includes('/uploads/')) {
      const rel = rawUrl.split('/uploads/').pop()?.split('?')[0];
      if (rel) {
        const parts = rel.split('/').filter(Boolean);
        const localPath = path.join(process.cwd(), 'uploads', ...parts);
        if (fs.existsSync(localPath)) {
          return localPath;
        }
      }
    }
    return rawUrl;
  }

  private probeHasAudio(rawUrl: string): Promise<boolean> {
    const url = this.resolveLocalFilePath(rawUrl);
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

  private getClipTrim(clip: any): { trimIn: number; trimOut: number; duration: number } {
    const trimIn = Math.max(0, clip.trimIn || 0);
    let duration = (clip.trimOut && clip.trimOut > trimIn)
      ? (clip.trimOut - trimIn)
      : ((clip.endTime - clip.startTime) || clip.asset?.duration || 5);
    
    if (duration <= 0) duration = 5;
    const trimOut = trimIn + duration;
    return { trimIn, trimOut, duration };
  }

  async findUserExports(userId?: string) {
    const whereClause: any = { type: 'export' };
    if (userId) whereClause.userId = userId;
    const assets = await this.prisma.asset.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    });
    return assets.map((a) => ({
      _id: a.id,
      ...a,
    }));
  }

  async export(sceneGraph: any, res: express.Response, requestOrigin: string, userId?: string) {
    // Dump to file for debug inside uploads folder safely
    try {
      const debugFile = path.join(process.cwd(), 'uploads', 'last_export.json');
      fs.writeFileSync(debugFile, JSON.stringify(sceneGraph, null, 2));
    } catch (e) {
      console.warn('Could not write last_export.json debug file:', e);
    }

    if (!sceneGraph || !sceneGraph.tracks || sceneGraph.tracks.length === 0) {
      throw new BadRequestException('Empty scene graph');
    }

    // Resolve any blob: URLs to actual database server URLs if available, or reject cleanly
    for (const track of sceneGraph.tracks || []) {
      for (const clip of track.clips || []) {
        const url = clip.asset?.original_url || clip.asset?.preview_url || '';
        if (url.startsWith('blob:')) {
          const assetId = clip.assetId || clip.asset?._id;
          if (assetId && !assetId.startsWith('temp_')) {
            const dbAsset = await this.prisma.asset.findUnique({ where: { id: assetId } });
            if (dbAsset) {
              clip.asset.original_url = dbAsset.original_url;
              clip.asset.preview_url = dbAsset.preview_url;
            }
          }
          if (clip.asset?.original_url?.startsWith('blob:')) {
            throw new BadRequestException(
              `Media file "${clip.asset?.public_id || 'clip'}" is still uploading to the server. Please wait a moment for upload to finish before exporting.`
            );
          }
        }
      }
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

    const exportFolder = userId ? path.join(process.cwd(), 'uploads', userId) : path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(exportFolder)) {
      fs.mkdirSync(exportFolder, { recursive: true });
    }
    const outputPath = path.join(exportFolder, `export_${Date.now()}.mp4`);

    const allClips = [...mainClips, ...audioClips];
    const hasAudioFlags = await Promise.all(
      allClips.map((clip) => this.probeHasAudio(clip.asset.preview_url || clip.asset.original_url)),
    );

    const command = ffmpeg();
    allClips.forEach((clip) => {
      const targetUrl = this.resolveLocalFilePath(clip.asset.preview_url || clip.asset.original_url);
      const isImage = clip.asset?.type === 'image' || (targetUrl && (targetUrl.endsWith('.png') || targetUrl.endsWith('.jpg') || targetUrl.endsWith('.jpeg')));
      if (isImage) {
        const { duration } = this.getClipTrim(clip);
        command.input(targetUrl).inputOptions(['-loop 1', `-t ${duration}`]);
      } else {
        command.input(targetUrl);
      }
    });

    let filter = '';

    // 1. Process Main Video Track
    if (mainClips.length === 1) {
      const clip = mainClips[0];
      const { trimIn, trimOut, duration } = this.getClipTrim(clip);
      const isClipMuted = clip.muted || clip.volume === 0;
      const vol = (clip.volume ?? 100) / 100;
      const isImage = clip.asset?.type === 'image';
      
      if (isImage) {
        filter += `[0:v]loop=loop=-1:size=1:start=0,trim=start=0:end=${duration},setpts=PTS-STARTPTS,scale=1280:720,setsar=1,fps=30,format=yuv420p[outv]; `;
      } else {
        filter += `[0:v]trim=start=${trimIn}:end=${trimOut},setpts=PTS-STARTPTS,scale=1280:720,setsar=1,fps=30,format=yuv420p[outv]; `;
      }

      if (hasAudioFlags[0] && !isClipMuted) {
        filter += `[0:a]atrim=start=${trimIn}:end=${trimOut},asetpts=PTS-STARTPTS,volume=${vol}[main_a]; `;
      } else {
        filter += `anullsrc=r=44100:cl=stereo:d=${duration}[main_a]; `;
      }
    } else {
      mainClips.forEach((clip, index) => {
        const { trimIn, trimOut, duration } = this.getClipTrim(clip);
        const isClipMuted = clip.muted || clip.volume === 0;
        const vol = (clip.volume ?? 100) / 100;
        const isImage = clip.asset?.type === 'image';

        if (isImage) {
          filter += `[${index}:v]loop=loop=-1:size=1:start=0,trim=start=0:end=${duration},setpts=PTS-STARTPTS,scale=1280:720,setsar=1,fps=30,format=yuv420p[v${index}]; `;
        } else {
          filter += `[${index}:v]trim=start=${trimIn}:end=${trimOut},setpts=PTS-STARTPTS,scale=1280:720,setsar=1,fps=30,format=yuv420p[v${index}]; `;
        }

        if (hasAudioFlags[index] && !isClipMuted) {
          filter += `[${index}:a]atrim=start=${trimIn}:end=${trimOut},asetpts=PTS-STARTPTS,volume=${vol}[a${index}]; `;
        } else {
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
      const { trimIn, trimOut } = this.getClipTrim(clip);
      const delayMs = Math.max(0, Math.floor((clip.startTime || 0) * 1000));
      const vol = (clip.volume ?? 100) / 100;
      filter += `[${index}:a]atrim=start=${trimIn}:end=${trimOut},asetpts=PTS-STARTPTS,adelay=delays=${delayMs}:all=1,volume=${vol}[aud${i}]; `;
      mixAudioInputs += `[aud${i}]`;
      numAudioInputs++;
    });

    if (numAudioInputs > 1) {
      filter += `${mixAudioInputs}amix=inputs=${numAudioInputs}:duration=first:dropout_transition=2:normalize=0[outa]`;
      command.complexFilter(filter, ['outv', 'outa']);
    } else {
      command.complexFilter(filter, ['outv', 'main_a']);
    }

    command
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-crf 26',
        '-preset fast',
        '-b:a 128k',
        '-movflags +faststart',
        '-shortest',
      ]);

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

    command.on('end', async () => {
      const filename = path.basename(outputPath);
      const fileUrl = userId ? `/uploads/${userId}/${filename}` : `/uploads/${filename}`;
      if (userId) {
        try {
          await this.prisma.asset.create({
            data: {
              original_url: fileUrl,
              preview_url: fileUrl,
              type: 'export',
              duration: sceneGraph.duration || 10,
              public_id: filename,
              userId: userId,
            },
          });
        } catch (e) {
          console.error('Failed to create DB asset record for export:', e);
        }
      }
      res.write(`data: ${JSON.stringify({ type: 'complete', url: `${requestOrigin}${fileUrl}` })}\n\n`);
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
