import {
  Controller,
  Get,
  Post,
  Body,
  UploadedFile,
  UseInterceptors,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { WorkerRegistryService } from './worker-registry.service';
import { RenderingService } from './rendering.service';
import * as express from 'express';

@Controller('rendering')
export class RenderingController {
  constructor(
    private readonly workerRegistry: WorkerRegistryService,
    private readonly renderingService: RenderingService,
  ) {}

  @Get('workers')
  getWorkersStatus() {
    return this.workerRegistry.getStats();
  }

  @Post('chunk-upload')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: join(process.cwd(), 'uploads', 'chunks'),
        filename: (req, file, cb) => {
          const jobId = req.body?.jobId || 'job';
          const segmentIndex = req.body?.segmentIndex || '0';
          const unique = `${jobId}_seg${segmentIndex}_${Date.now()}${extname(file.originalname || '.mp4')}`;
          cb(null, unique);
        },
      }),
    }),
  )
  uploadRenderedChunk(
    @UploadedFile() file: Express.Multer.File,
    @Body('jobId') jobId: string,
    @Body('segmentIndex') segmentIndex: string,
  ) {
    if (!file) {
      throw new BadRequestException('No chunk uploaded');
    }

    return {
      message: 'Chunk uploaded successfully',
      filename: file.filename,
      jobId,
      segmentIndex: parseInt(segmentIndex, 10),
    };
  }

  @Post('export-distributed')
  async exportDistributed(
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
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          message: error.message || 'Distributed render failed',
        })}\n\n`,
      );
      res.end();
    }
  }
}
