import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { WorkerRegistryService, NodeState, ClusterLogEntry } from './worker-registry.service';
import { RenderingService } from './rendering.service';

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  namespace: '/rendering-ws',
})
export class RenderingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RenderingGateway.name);

  constructor(
    private readonly workerRegistry: WorkerRegistryService,
    @Inject(forwardRef(() => RenderingService))
    private readonly renderingService: RenderingService,
  ) {
    // Pipe internal registry logs directly to connected admin sockets
    this.workerRegistry.onLogAdded((log: ClusterLogEntry) => {
      if (this.server) {
        this.server.to('admin:cluster').emit('admin:cluster_log', log);
      }
    });
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to rendering gateway: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from rendering gateway: ${client.id}`);
    this.workerRegistry.unregisterWorker(client.id);
    this.broadcastStats();
  }

  @SubscribeMessage('worker:register')
  handleRegister(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId?: string; userName?: string; cores?: number; memoryGb?: number },
  ) {
    const worker = this.workerRegistry.registerWorker(client.id, data || {});
    client.emit('worker:registered', { status: 'OK', workerId: client.id });
    this.broadcastStats();
    return worker;
  }

  @SubscribeMessage('worker:heartbeat')
  handleHeartbeat(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      status?: 'IDLE' | 'BUSY';
      state?: NodeState;
      activityScore?: number;
      idleSeconds?: number;
      workerAvailable?: boolean;
    },
  ) {
    this.workerRegistry.updateHeartbeat(client.id, data);
    this.broadcastStats();
  }

  @SubscribeMessage('worker:state_change')
  handleStateChange(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      state: NodeState;
      score: number;
      idleSeconds: number;
    },
  ) {
    this.workerRegistry.handleStateChange(client.id, data.state, data.score, data.idleSeconds);
    this.broadcastStats();
  }

  @SubscribeMessage('worker:preempt')
  handlePreempt(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      jobId?: string;
      reason?: string;
      checkpoint?: any;
      lastSegment?: number;
    },
  ) {
    this.logger.warn(`Worker ${client.id} triggered PREEMPT! Reason: ${data.reason}`);
    this.workerRegistry.handleWorkerPreempt(client.id, data);
    if (data.jobId && typeof data.lastSegment === 'number') {
      this.renderingService.onSegmentPreempted(data.jobId, data.lastSegment, data.checkpoint);
    }
    this.broadcastStats();
  }

  @SubscribeMessage('worker:segment_progress')
  handleSegmentProgress(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { jobId: string; segmentIndex: number; percent: number },
  ) {
    this.renderingService.onSegmentProgress(data.jobId, data.segmentIndex, data.percent);
  }

  @SubscribeMessage('worker:segment_complete')
  handleSegmentComplete(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { jobId: string; segmentIndex: number; chunkFileName: string; chunkUrl?: string },
  ) {
    this.workerRegistry.setWorkerIdle(client.id, true);
    this.renderingService.onSegmentComplete(data.jobId, data.segmentIndex, data.chunkFileName);
    this.broadcastStats();
  }

  @SubscribeMessage('worker:segment_error')
  handleSegmentError(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { jobId: string; segmentIndex: number; error: string },
  ) {
    this.logger.error(`Worker ${client.id} failed segment ${data.segmentIndex} on job ${data.jobId}: ${data.error}`);
    this.workerRegistry.setWorkerIdle(client.id, false);
    this.renderingService.onSegmentFailed(data.jobId, data.segmentIndex, data.error);
    this.broadcastStats();
  }

  // Admin-only subscription channel
  @SubscribeMessage('admin:subscribe')
  handleAdminSubscribe(@ConnectedSocket() client: Socket) {
    client.join('admin:cluster');
    const stats = this.workerRegistry.getStats();
    const initialLogs = this.workerRegistry.getLogs({ limit: 50 });
    client.emit('admin:initial_telemetry', { stats, logs: initialLogs });
    this.logger.log(`Socket ${client.id} joined admin:cluster stream.`);
  }

  @SubscribeMessage('admin:unsubscribe')
  handleAdminUnsubscribe(@ConnectedSocket() client: Socket) {
    client.leave('admin:cluster');
  }

  assignSegmentToWorker(socketId: string, payload: any) {
    this.server.to(socketId).emit('render:assign_segment', payload);
  }

  broadcastStats() {
    if (this.server) {
      const stats = this.workerRegistry.getStats();
      this.server.emit('network:stats', stats);
      this.server.to('admin:cluster').emit('admin:stats_update', stats);
    }
  }
}
