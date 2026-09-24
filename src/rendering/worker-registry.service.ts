import { Injectable, Logger } from '@nestjs/common';

export type NodeState =
  | 'ACTIVE'
  | 'IDLE_CANDIDATE'
  | 'IDLE'
  | 'RENDERING'
  | 'PREEMPTED'
  | 'PAUSED'
  | 'OFFLINE';

export interface WorkerNode {
  socketId: string;
  userId?: string;
  userName: string;
  cores: number;
  memoryGb?: number;
  state: NodeState;
  activityScore: number;
  idleSeconds: number;
  status: 'IDLE' | 'BUSY'; // backward compatibility
  currentJobId?: string;
  currentSegmentIndex?: number;
  jobsCompleted: number;
  joinedAt: number;
  lastHeartbeat: number;
  lastPreemptReason?: string;
  checkpoint?: any;
}

export type ClusterLogLevel = 'info' | 'warn' | 'error' | 'success';

export interface ClusterLogEntry {
  id: string;
  timestamp: number;
  workerId: string;
  userName: string;
  eventType:
    | 'NODE_REGISTERED'
    | 'STATE_CHANGE'
    | 'HEARTBEAT'
    | 'PREEMPTED'
    | 'JOB_ASSIGNED'
    | 'JOB_PROGRESS'
    | 'JOB_COMPLETED'
    | 'JOB_FAILED'
    | 'NODE_DISCONNECTED'
    | 'NODE_TIMEOUT';
  level: ClusterLogLevel;
  message: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class WorkerRegistryService {
  private readonly logger = new Logger(WorkerRegistryService.name);
  private workers: Map<string, WorkerNode> = new Map();
  private logs: ClusterLogEntry[] = [];
  private readonly MAX_LOGS = 300;
  private logListeners: Array<(log: ClusterLogEntry) => void> = [];

  constructor() {
    // Background interval to check 15s timeout
    setInterval(() => this.checkTimeouts(), 5000);
  }

  onLogAdded(listener: (log: ClusterLogEntry) => void) {
    this.logListeners.push(listener);
    return () => {
      this.logListeners = this.logListeners.filter((l) => l !== listener);
    };
  }

  addLog(entry: Omit<ClusterLogEntry, 'id' | 'timestamp'>): ClusterLogEntry {
    const log: ClusterLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      timestamp: Date.now(),
      ...entry,
    };

    this.logs.unshift(log);
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.pop();
    }

    // Notify real-time listeners (admin room)
    for (const listener of this.logListeners) {
      try {
        listener(log);
      } catch (err) {
        this.logger.error(`Error notifying log listener: ${err.message}`);
      }
    }

    return log;
  }

  registerWorker(
    socketId: string,
    info: { userId?: string; userName?: string; cores?: number; memoryGb?: number },
  ): WorkerNode {
    const node: WorkerNode = {
      socketId,
      userId: info.userId,
      userName: info.userName || 'Anonymous Contributor',
      cores: info.cores || 4,
      memoryGb: info.memoryGb || 8,
      state: 'ACTIVE',
      activityScore: 50,
      idleSeconds: 0,
      status: 'IDLE',
      jobsCompleted: 0,
      joinedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };

    this.workers.set(socketId, node);

    this.addLog({
      workerId: socketId,
      userName: node.userName,
      eventType: 'NODE_REGISTERED',
      level: 'info',
      message: `Worker node registered: ${node.userName} (${node.cores} cores, ${node.memoryGb}GB RAM)`,
      metadata: { cores: node.cores, memoryGb: node.memoryGb, userId: node.userId },
    });

    this.logger.log(`Worker registered: ${socketId} (${node.userName}) - Total: ${this.workers.size}`);
    return node;
  }

  unregisterWorker(socketId: string): void {
    const worker = this.workers.get(socketId);
    if (worker) {
      this.addLog({
        workerId: socketId,
        userName: worker.userName,
        eventType: 'NODE_DISCONNECTED',
        level: 'warn',
        message: `Worker node disconnected: ${worker.userName}`,
      });
      this.workers.delete(socketId);
      this.logger.log(`Worker unregistered: ${socketId} - Remaining: ${this.workers.size}`);
    }
  }

  updateHeartbeat(
    socketId: string,
    data?: {
      status?: 'IDLE' | 'BUSY';
      state?: NodeState;
      activityScore?: number;
      idleSeconds?: number;
      workerAvailable?: boolean;
    },
  ): void {
    const worker = this.workers.get(socketId);
    if (worker) {
      const prevState = worker.state;
      worker.lastHeartbeat = Date.now();

      if (data?.state) {
        worker.state = data.state;
      }
      if (typeof data?.activityScore === 'number') {
        worker.activityScore = data.activityScore;
      }
      if (typeof data?.idleSeconds === 'number') {
        worker.idleSeconds = data.idleSeconds;
      }
      if (data?.status) {
        worker.status = data.status;
      }

      // If state transitioned
      if (data?.state && data.state !== prevState) {
        this.addLog({
          workerId: socketId,
          userName: worker.userName,
          eventType: 'STATE_CHANGE',
          level: data.state === 'IDLE' ? 'success' : 'info',
          message: `State changed: ${prevState} -> ${data.state} (Score: ${worker.activityScore}, Inactivity: ${worker.idleSeconds}s)`,
          metadata: { from: prevState, to: data.state, score: worker.activityScore, idleSeconds: worker.idleSeconds },
        });
      }
    }
  }

  handleStateChange(
    socketId: string,
    newState: NodeState,
    score: number,
    idleSeconds: number,
  ): void {
    const worker = this.workers.get(socketId);
    if (worker) {
      const oldState = worker.state;
      worker.state = newState;
      worker.activityScore = score;
      worker.idleSeconds = idleSeconds;
      worker.lastHeartbeat = Date.now();

      this.addLog({
        workerId: socketId,
        userName: worker.userName,
        eventType: 'STATE_CHANGE',
        level: newState === 'IDLE' ? 'success' : newState === 'ACTIVE' ? 'info' : 'warn',
        message: `State updated to ${newState} (Score: ${score}/100, Inactivity: ${idleSeconds}s)`,
        metadata: { oldState, newState, score, idleSeconds },
      });
    }
  }

  handleWorkerPreempt(
    socketId: string,
    data: { jobId?: string; reason?: string; checkpoint?: any; lastSegment?: number },
  ): void {
    const worker = this.workers.get(socketId);
    if (worker) {
      worker.state = 'PREEMPTED';
      worker.status = 'IDLE';
      worker.lastPreemptReason = data.reason || 'USER_ACTIVITY';
      worker.checkpoint = data.checkpoint;
      worker.lastHeartbeat = Date.now();

      this.addLog({
        workerId: socketId,
        userName: worker.userName,
        eventType: 'PREEMPTED',
        level: 'warn',
        message: `🚨 Worker PREEMPTED by ${worker.lastPreemptReason}! Immediate local pause executed (0ms UI latency). Segment: #${data.lastSegment || worker.currentSegmentIndex || 0}`,
        metadata: { jobId: data.jobId || worker.currentJobId, reason: worker.lastPreemptReason, checkpoint: data.checkpoint },
      });

      // After pause, worker returns to ACTIVE
      setTimeout(() => {
        if (worker.state === 'PREEMPTED') {
          worker.state = 'ACTIVE';
        }
      }, 500);
    }
  }

  setWorkerBusy(socketId: string, jobId: string, segmentIndex: number): void {
    const worker = this.workers.get(socketId);
    if (worker) {
      worker.status = 'BUSY';
      worker.state = 'RENDERING';
      worker.currentJobId = jobId;
      worker.currentSegmentIndex = segmentIndex;

      this.addLog({
        workerId: socketId,
        userName: worker.userName,
        eventType: 'JOB_ASSIGNED',
        level: 'info',
        message: `Assigned Segment #${segmentIndex} of Job ${jobId.slice(0, 8)}...`,
        metadata: { jobId, segmentIndex },
      });
    }
  }

  setWorkerIdle(socketId: string, incrementCompleted = true): void {
    const worker = this.workers.get(socketId);
    if (worker) {
      worker.status = 'IDLE';
      worker.state = 'IDLE';
      const prevJob = worker.currentJobId;
      const prevSeg = worker.currentSegmentIndex;
      worker.currentJobId = undefined;
      worker.currentSegmentIndex = undefined;
      if (incrementCompleted) {
        worker.jobsCompleted += 1;
        this.addLog({
          workerId: socketId,
          userName: worker.userName,
          eventType: 'JOB_COMPLETED',
          level: 'success',
          message: `✓ Completed Segment #${prevSeg} for Job ${prevJob?.slice(0, 8) || 'unknown'}. Total completed: ${worker.jobsCompleted}`,
          metadata: { jobId: prevJob, segmentIndex: prevSeg, total: worker.jobsCompleted },
        });
      }
    }
  }

  checkTimeouts(timeoutMs = 15000): void {
    const now = Date.now();
    for (const [id, worker] of this.workers.entries()) {
      if (now - worker.lastHeartbeat > timeoutMs && worker.state !== 'OFFLINE') {
        const missedSec = Math.round((now - worker.lastHeartbeat) / 1000);
        worker.state = 'OFFLINE';
        worker.status = 'IDLE';

        this.addLog({
          workerId: id,
          userName: worker.userName,
          eventType: 'NODE_TIMEOUT',
          level: 'error',
          message: `Worker node TIMEOUT (No heartbeat for ${missedSec}s > ${timeoutMs / 1000}s limit). Marked OFFLINE.`,
          metadata: { missedSeconds: missedSec },
        });

        this.logger.warn(`Worker node timeout: ${id} (${missedSec}s inactive)`);
      }

      // Hard purge if inactive > 60s
      if (now - worker.lastHeartbeat > 60000) {
        this.workers.delete(id);
      }
    }
  }

  getIdleWorkers(): WorkerNode[] {
    this.checkTimeouts();
    return Array.from(this.workers.values()).filter(
      (w) => w.state === 'IDLE' && w.status === 'IDLE',
    );
  }

  getAllWorkers(): WorkerNode[] {
    return Array.from(this.workers.values());
  }

  getLogs(options?: {
    eventType?: string;
    level?: string;
    workerId?: string;
    limit?: number;
  }): ClusterLogEntry[] {
    let result = this.logs;
    if (options?.eventType && options.eventType !== 'ALL') {
      result = result.filter((l) => l.eventType === options.eventType);
    }
    if (options?.level && options.level !== 'ALL') {
      result = result.filter((l) => l.level === options.level);
    }
    if (options?.workerId) {
      result = result.filter((l) => l.workerId === options.workerId);
    }
    const limit = options?.limit || 150;
    return result.slice(0, limit);
  }

  clearLogs(): void {
    this.logs = [];
    this.addLog({
      workerId: 'SYSTEM',
      userName: 'Cluster Controller',
      eventType: 'STATE_CHANGE',
      level: 'info',
      message: 'Admin cleared cluster activity logs.',
    });
  }

  getStats() {
    const all = Array.from(this.workers.values());
    const idle = all.filter((w) => w.state === 'IDLE').length;
    const candidates = all.filter((w) => w.state === 'IDLE_CANDIDATE').length;
    const active = all.filter((w) => w.state === 'ACTIVE').length;
    const busy = all.filter((w) => w.state === 'RENDERING').length;
    const preempted = all.filter((w) => w.state === 'PREEMPTED' || w.state === 'PAUSED').length;
    const offline = all.filter((w) => w.state === 'OFFLINE').length;
    const totalCompleted = all.reduce((sum, w) => sum + w.jobsCompleted, 0);

    return {
      totalWorkers: all.length,
      idleWorkers: idle,
      candidateWorkers: candidates,
      activeWorkers: active,
      busyWorkers: busy,
      preemptedWorkers: preempted,
      offlineWorkers: offline,
      totalSegmentsRendered: totalCompleted,
      workers: all.map((w) => ({
        socketId: w.socketId,
        userName: w.userName,
        userId: w.userId,
        state: w.state,
        status: w.status,
        activityScore: w.activityScore,
        idleSeconds: w.idleSeconds,
        cores: w.cores,
        memoryGb: w.memoryGb,
        currentJobId: w.currentJobId,
        currentSegmentIndex: w.currentSegmentIndex,
        jobsCompleted: w.jobsCompleted,
        lastHeartbeat: w.lastHeartbeat,
      })),
    };
  }
}
