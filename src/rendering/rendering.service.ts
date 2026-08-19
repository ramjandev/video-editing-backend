import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { WorkerRegistryService, WorkerNode } from './worker-registry.service';
import { RenderingGateway } from './rendering.gateway';
import { ExportService } from '../export/export.service';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import * as fs from 'fs';
import * as path from 'path';

// Configure FFMPEG path
ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);

export interface RenderSegment {
  index: number;
  startSec: number;
  endSec: number;
  duration: number;
  status: 'PENDING' | 'ASSIGNED' | 'RENDERING' | 'COMPLETED' | 'FAILED';
  workerSocketId?: string;
  chunkFileName?: string;
  progress: number;
  assignedAt?: number;
}

export interface DistributedJob {
  id: string;
  sceneGraph: any;
  requestOrigin: string;
  totalDuration: number;
  segments: RenderSegment[];
  onEvent: (evt: any) => void;
  createdAt: number;
  status: 'QUEUED' | 'RUNNING' | 'STITCHING' | 'COMPLETED' | 'FAILED';
  outputFileName?: string;
  timeoutRef?: NodeJS.Timeout;
}

@Injectable()
export class RenderingService {
  private readonly logger = new Logger(RenderingService.name);
  private jobs: Map<string, DistributedJob> = new Map();

  constructor(
    private readonly workerRegistry: WorkerRegistryService,
    @Inject(forwardRef(() => RenderingGateway))
    private readonly gateway: RenderingGateway,
    private readonly exportService: ExportService,
  ) {
    // Ensure chunks directory exists
    const chunksDir = path.join(process.cwd(), 'uploads', 'chunks');
    if (!fs.existsSync(chunksDir)) {
      fs.mkdirSync(chunksDir, { recursive: true });
    }
  }

  async startRender(
    sceneGraph: any,
    onEvent: (evt: any) => void,
    requestOrigin: string,
  ): Promise<void> {
    const totalDuration = sceneGraph.duration || 10;
    const idleWorkers = this.workerRegistry.getIdleWorkers();

    this.logger.log(`Render requested. Total duration: ${totalDuration}s. Idle workers available: ${idleWorkers.length}`);

    // If no workers connected, fallback gracefully to server-side export
    if (idleWorkers.length === 0) {
      this.logger.log('No distributed workers available. Utilizing server FFmpeg export engine...');
      onEvent({
        type: 'progress',
        percent: 5,
        etaSeconds: null,
        status: 'Rendering on Server FFmpeg Engine...',
      });
      return this.exportService.export(sceneGraph, {
        write: (str: string) => {
          const lines = str.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                onEvent(data);
              } catch {}
            }
          }
        },
        setHeader: () => {},
        end: () => {},
      } as any, requestOrigin);
    }

    // Distributed Rendering Mode!
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const segmentDuration = totalDuration > 30 ? 10 : Math.max(4, Math.ceil(totalDuration / Math.max(2, idleWorkers.length)));
    const numSegments = Math.ceil(totalDuration / segmentDuration);

    const segments: RenderSegment[] = [];
    for (let i = 0; i < numSegments; i++) {
      const startSec = i * segmentDuration;
      const endSec = Math.min(totalDuration, (i + 1) * segmentDuration);
      segments.push({
        index: i,
        startSec,
        endSec,
        duration: endSec - startSec,
        status: 'PENDING',
        progress: 0,
      });
    }

    const job: DistributedJob = {
      id: jobId,
      sceneGraph,
      requestOrigin,
      totalDuration,
      segments,
      onEvent,
      createdAt: Date.now(),
      status: 'RUNNING',
    };

    this.jobs.set(jobId, job);

    onEvent({
      type: 'progress',
      percent: 0,
      etaSeconds: null,
      status: `Distributed rendering started across ${Math.min(idleWorkers.length, numSegments)} nodes (${numSegments} segments)...`,
    });

    this.dispatchPendingSegments(job);
  }

  private createSegmentSceneGraph(fullSceneGraph: any, startSec: number, endSec: number) {
    const segmentDuration = endSec - startSec;
    const tracks = (fullSceneGraph.tracks || []).map((track: any) => {
      const clipsInSegment = (track.clips || [])
        .filter((clip: any) => clip.endTime > startSec && clip.startTime < endSec)
        .map((clip: any) => {
          const clipStartInSegment = Math.max(0, clip.startTime - startSec);
          const clipEndInSegment = Math.min(segmentDuration, clip.endTime - startSec);
          const trimmedIn = clip.trimIn + Math.max(0, startSec - clip.startTime);
          const trimmedOut = trimmedIn + (clipEndInSegment - clipStartInSegment);

          return {
            ...clip,
            startTime: clipStartInSegment,
            endTime: clipEndInSegment,
            trimIn: trimmedIn,
            trimOut: trimmedOut,
          };
        });

      return {
        ...track,
        clips: clipsInSegment,
      };
    });

    return {
      ...fullSceneGraph,
      duration: segmentDuration,
      tracks,
    };
  }

  private dispatchPendingSegments(job: DistributedJob) {
    const idleWorkers = this.workerRegistry.getIdleWorkers();
    const pendingSegments = job.segments.filter((s) => s.status === 'PENDING');

    if (pendingSegments.length === 0) return;

    for (let i = 0; i < Math.min(idleWorkers.length, pendingSegments.length); i++) {
      const worker = idleWorkers[i];
      const segment = pendingSegments[i];

      segment.status = 'ASSIGNED';
      segment.workerSocketId = worker.socketId;
      segment.assignedAt = Date.now();

      this.workerRegistry.setWorkerBusy(worker.socketId, job.id, segment.index);

      const segmentSceneGraph = this.createSegmentSceneGraph(job.sceneGraph, segment.startSec, segment.endSec);

      this.gateway.assignSegmentToWorker(worker.socketId, {
        jobId: job.id,
        segmentIndex: segment.index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        duration: segment.duration,
        fps: job.sceneGraph.fps || 30,
        resolution: job.sceneGraph.resolution || { w: 1280, h: 720 },
        segmentSceneGraph,
        uploadEndpoint: `${job.requestOrigin}/api/rendering/chunk-upload`,
      });

      this.logger.log(`Dispatched segment ${segment.index} [${segment.startSec}s - ${segment.endSec}s] to worker ${worker.socketId}`);
    }
  }

  onSegmentProgress(jobId: string, segmentIndex: number, percent: number) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const segment = job.segments.find((s) => s.index === segmentIndex);
    if (segment) {
      segment.progress = percent;
      segment.status = 'RENDERING';
    }

    this.calculateAndEmitOverallProgress(job);
  }

  onSegmentComplete(jobId: string, segmentIndex: number, chunkFileName: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const segment = job.segments.find((s) => s.index === segmentIndex);
    if (segment) {
      segment.status = 'COMPLETED';
      segment.chunkFileName = chunkFileName;
      segment.progress = 100;
      this.logger.log(`Job ${jobId}: Segment ${segmentIndex} COMPLETED (${chunkFileName})`);
    }

    // Check if more pending segments need worker assignment
    this.dispatchPendingSegments(job);
    this.calculateAndEmitOverallProgress(job);

    // Check if all segments are completed
    const allCompleted = job.segments.every((s) => s.status === 'COMPLETED');
    if (allCompleted) {
      this.stitchAndFinalizeJob(job);
    }
  }

  onSegmentFailed(jobId: string, segmentIndex: number, error: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const segment = job.segments.find((s) => s.index === segmentIndex);
    if (segment) {
      this.logger.warn(`Job ${jobId}: Segment ${segmentIndex} failed by worker. Rerouting...`);
      // Try to re-assign to another worker or fallback
      segment.status = 'PENDING';
      segment.workerSocketId = undefined;
      segment.progress = 0;

      const idle = this.workerRegistry.getIdleWorkers();
      if (idle.length > 0) {
        this.dispatchPendingSegments(job);
      } else {
        // Fallback: render this chunk locally
        this.renderSegmentLocally(job, segment);
      }
    }
  }

  private async renderSegmentLocally(job: DistributedJob, segment: RenderSegment) {
    segment.status = 'RENDERING';
    const chunkFileName = `chunk_${job.id}_${segment.index}_fallback.mp4`;
    const chunkPath = path.join(process.cwd(), 'uploads', 'chunks', chunkFileName);
    const segmentSceneGraph = this.createSegmentSceneGraph(job.sceneGraph, segment.startSec, segment.endSec);

    try {
      await new Promise<void>((resolve, reject) => {
        this.exportService.export(segmentSceneGraph, {
          write: () => {},
          setHeader: () => {},
          end: () => resolve(),
        } as any, job.requestOrigin).then(() => resolve()).catch(reject);
      });
      // Move exported file if needed
      segment.status = 'COMPLETED';
      segment.chunkFileName = chunkFileName;
      segment.progress = 100;
      this.calculateAndEmitOverallProgress(job);

      if (job.segments.every((s) => s.status === 'COMPLETED')) {
        this.stitchAndFinalizeJob(job);
      }
    } catch (e) {
      this.logger.error(`Fallback rendering failed for segment ${segment.index}`, e);
    }
  }

  private calculateAndEmitOverallProgress(job: DistributedJob) {
    const totalSegments = job.segments.length;
    if (totalSegments === 0) return;

    const totalProgressSum = job.segments.reduce((sum, s) => sum + s.progress, 0);
    const overallPercent = Math.min(95, Math.round(totalProgressSum / totalSegments));

    const completedSegments = job.segments.filter((s) => s.status === 'COMPLETED').length;
    const renderingSegments = job.segments.filter((s) => s.status === 'RENDERING').length;

    job.onEvent({
      type: 'progress',
      percent: overallPercent,
      etaSeconds: Math.max(1, Math.ceil((100 - overallPercent) / 5)),
      status: `Distributed: ${completedSegments}/${totalSegments} segments done (${renderingSegments} active workers)...`,
    });
  }

  private async stitchAndFinalizeJob(job: DistributedJob) {
    job.status = 'STITCHING';
    job.onEvent({
      type: 'progress',
      percent: 96,
      etaSeconds: 2,
      status: 'Stitching rendered video segments together...',
    });

    const outputFileName = `export_distributed_${Date.now()}.mp4`;
    const outputPath = path.join(process.cwd(), 'uploads', outputFileName);
    const manifestPath = path.join(process.cwd(), 'uploads', 'chunks', `manifest_${job.id}.txt`);

    // Sort segments by index
    const sortedSegments = [...job.segments].sort((a, b) => a.index - b.index);

    // Build FFmpeg concat manifest
    const manifestLines = sortedSegments.map((s) => {
      const fullChunkPath = path.join(process.cwd(), 'uploads', 'chunks', s.chunkFileName || '');
      // Format file paths for ffmpeg concat
      return `file '${fullChunkPath.replace(/\\/g, '/')}'`;
    });

    fs.writeFileSync(manifestPath, manifestLines.join('\n'), 'utf8');

    this.logger.log(`Stitching ${sortedSegments.length} chunks into ${outputPath}`);

    ffmpeg()
      .input(manifestPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(outputPath)
      .on('end', () => {
        this.logger.log(`Distributed render complete: ${outputFileName}`);
        job.status = 'COMPLETED';
        job.onEvent({
          type: 'complete',
          url: `${job.requestOrigin}/uploads/${outputFileName}`,
        });

        // Cleanup manifest and temporary chunks
        try {
          if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
        } catch {}
      })
      .on('error', (err) => {
        this.logger.error('FFmpeg concat failed, attempting re-encode stitch...', err);
        // Fallback with re-encode if copy fails due to codec differences
        ffmpeg()
          .input(manifestPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .videoCodec('libx264')
          .audioCodec('aac')
          .output(outputPath)
          .on('end', () => {
            job.status = 'COMPLETED';
            job.onEvent({
              type: 'complete',
              url: `${job.requestOrigin}/uploads/${outputFileName}`,
            });
          })
          .on('error', (err2) => {
            this.logger.error('Final stitch failed completely', err2);
            job.onEvent({
              type: 'error',
              message: `Failed to stitch video chunks: ${err2.message}`,
            });
          })
          .run();
      })
      .run();
  }
}
