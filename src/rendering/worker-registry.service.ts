import { Injectable, Logger } from '@nestjs/common';

export interface WorkerNode {
  socketId: string;
  userId?: string;
  userName?: string;
  cores: number;
  memoryGb?: number;
  status: 'IDLE' | 'BUSY';
  currentJobId?: string;
  currentSegmentIndex?: number;
  jobsCompleted: number;
  joinedAt: number;
  lastHeartbeat: number;
}

@Injectable()
export class WorkerRegistryService {
  private readonly logger = new Logger(WorkerRegistryService.name);
  private workers: Map<string, WorkerNode> = new Map();

  registerWorker(socketId: string, info: { userId?: string; userName?: string; cores?: number; memoryGb?: number }) {
    const node: WorkerNode = {
      socketId,
      userId: info.userId,
      userName: info.userName || 'Anonymous Contributor',
      cores: info.cores || 4,
      memoryGb: info.memoryGb || 8,
      status: 'IDLE',
      jobsCompleted: 0,
      joinedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };
    this.workers.set(socketId, node);
    this.logger.log(`Worker registered: ${socketId} (${node.userName}) - Total workers: ${this.workers.size}`);
    return node;
  }

  unregisterWorker(socketId: string) {
    if (this.workers.has(socketId)) {
      this.workers.delete(socketId);
      this.logger.log(`Worker unregistered: ${socketId} - Total workers: ${this.workers.size}`);
    }
  }

  updateHeartbeat(socketId: string, status?: 'IDLE' | 'BUSY') {
    const worker = this.workers.get(socketId);
    if (worker) {
      worker.lastHeartbeat = Date.now();
      if (status) worker.status = status;
    }
  }

  setWorkerBusy(socketId: string, jobId: string, segmentIndex: number) {
    const worker = this.workers.get(socketId);
    if (worker) {
      worker.status = 'BUSY';
      worker.currentJobId = jobId;
      worker.currentSegmentIndex = segmentIndex;
    }
  }

  setWorkerIdle(socketId: string, incrementCompleted = true) {
    const worker = this.workers.get(socketId);
    if (worker) {
      worker.status = 'IDLE';
      worker.currentJobId = undefined;
      worker.currentSegmentIndex = undefined;
      if (incrementCompleted) {
        worker.jobsCompleted += 1;
      }
    }
  }

  getIdleWorkers(): WorkerNode[] {
    const now = Date.now();
    // Prune stale workers (> 45s without heartbeat)
    for (const [id, worker] of this.workers.entries()) {
      if (now - worker.lastHeartbeat > 45000) {
        this.logger.warn(`Pruning stale worker: ${id}`);
        this.workers.delete(id);
      }
    }

    return Array.from(this.workers.values()).filter((w) => w.status === 'IDLE');
  }

  getAllWorkers(): WorkerNode[] {
    return Array.from(this.workers.values());
  }

  getStats() {
    const all = Array.from(this.workers.values());
    const idle = all.filter((w) => w.status === 'IDLE').length;
    const busy = all.filter((w) => w.status === 'BUSY').length;
    const totalCompleted = all.reduce((sum, w) => sum + w.jobsCompleted, 0);

    return {
      totalWorkers: all.length,
      idleWorkers: idle,
      busyWorkers: busy,
      totalSegmentsRendered: totalCompleted,
      workers: all.map((w) => ({
        socketId: w.socketId,
        userName: w.userName,
        status: w.status,
        cores: w.cores,
        jobsCompleted: w.jobsCompleted,
      })),
    };
  }
}
