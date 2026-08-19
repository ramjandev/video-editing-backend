import { Controller, Post, Body, Req, Res, Inject, forwardRef } from '@nestjs/common';
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

  @Post()
  async exportVideo(
    @Body('sceneGraph') sceneGraph: any,
    @Req() req: express.Request,
    @Res() res: express.Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const requestOrigin = `${protocol}://${host}`;

    try {
      await this.renderingService.startRender(
        sceneGraph,
        (evt) => {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
          if (evt.type === 'complete' || evt.type === 'error') {
            res.end();
          }
        },
        requestOrigin,
      );
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
