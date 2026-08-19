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
import { WorkerRegistryService } from './worker-registry.service';
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
  ) {}

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
    @MessageBody() data: { status?: 'IDLE' | 'BUSY' },
  ) {
    this.workerRegistry.updateHeartbeat(client.id, data?.status);
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

  assignSegmentToWorker(socketId: string, payload: any) {
    this.server.to(socketId).emit('render:assign_segment', payload);
  }

  broadcastStats() {
    if (this.server) {
      const stats = this.workerRegistry.getStats();
      this.server.emit('network:stats', stats);
    }
  }
}
