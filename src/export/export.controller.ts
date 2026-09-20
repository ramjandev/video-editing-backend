import { Controller, Post, Get, Body, Req, Res, Inject, forwardRef, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import * as express from 'express';
import { ExportService } from './export.service';
import { RenderingService } from '../rendering/rendering.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('export')
@UseGuards(JwtAuthGuard)
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

  /**
   * POST /export/browser-upload
   * Receives a browser-rendered video file (MP4 or WebM) and saves it as an export asset.
   */
  @Post('browser-upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2000 * 1024 * 1024 }, // 2GB max
      storage: diskStorage({
        destination: (req: any, file, cb) => {
          const uploadsDir = join(process.cwd(), 'uploads');
          if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
          }
          cb(null, uploadsDir);
        },
        filename: (req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          let ext = extname(file.originalname || '').toLowerCase();
          if (!ext) {
            ext = file.mimetype?.includes('mp4') ? '.mp4' : '.webm';
          }
          cb(null, `browser_export_${uniqueSuffix}${ext}`);
        },
      }),
    }),
  )
  async browserUpload(@UploadedFile() file: any, @Req() req: any) {
    if (!file) {
      return { error: 'No file uploaded' };
    }

    const host = req.headers['x-forwarded-host'] || req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const requestOrigin = `${protocol}://${host}`;
    const userId = req.user?.id;

    const fileUrl = `/uploads/${file.filename}`;
    const fullUrl = `${requestOrigin}${fileUrl}`;

    // Create export asset record in DB
    try {
      await this.exportService.createExportAsset(fileUrl, userId);
    } catch (err) {
      console.error('Failed to create export asset record:', err);
    }

    return { url: fileUrl, fullUrl, filename: file.filename };
  }
}
