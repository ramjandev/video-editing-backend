import { Controller, Post, Get, Body, Req, Res, Inject, forwardRef } from '@nestjs/common';
import * as express from 'express';
import { ExportService } from './export.service';
import { RenderingService } from '../rendering/rendering.service';

@Controller('export')
export class ExportController {
  constructor(
    private readonly exportService: ExportService,
    @Inject(forwardRef(() => RenderingService))
    private readonly renderingService: RenderingService,
  ) {}

  @Get('my-exports')
  async getMyExports(@Req() req: any) {
    const userId = req.user?.id;
    return await this.exportService.findUserExports(userId);
  }

  @Post()
  async exportVideo(
    @Body('sceneGraph') sceneGraph: any,
    @Req() req: any,
    @Res() res: express.Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const host = req.headers['x-forwarded-host'] || req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const requestOrigin = `${protocol}://${host}`;
    const userId = req.user?.id;

    try {
      await this.exportService.export(sceneGraph, res, requestOrigin, userId);
    } catch (error: any) {
      console.error('Export initiation error:', error);
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          message: error.message || 'Failed to start export rendering',
        })}\n\n`,
      );
      res.end();
    }
  }
}
