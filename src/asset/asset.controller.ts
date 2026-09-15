import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  UseInterceptors,
  UploadedFile,
  Req,
  Res,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as express from 'express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { AssetService } from './asset.service';
import { probeDuration } from '../common/ffmpeg.util';

@Controller('assets')
export class AssetController {
  constructor(private readonly assetService: AssetService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('video', {
      limits: { fileSize: 5000 * 1024 * 1024 },
      storage: diskStorage({
        destination: join(process.cwd(), 'uploads'),
        filename: (req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          let ext = extname(file.originalname || '').toLowerCase();
          if (!ext) {
            if (file.mimetype?.includes('png')) ext = '.png';
            else if (file.mimetype?.includes('jpeg') || file.mimetype?.includes('jpg')) ext = '.jpg';
            else if (file.mimetype?.includes('gif')) ext = '.gif';
            else if (file.mimetype?.includes('webp')) ext = '.webp';
            else if (file.mimetype?.includes('mp4')) ext = '.mp4';
            else if (file.mimetype?.includes('webm')) ext = '.webm';
            else if (file.mimetype?.includes('ogg')) ext = '.ogg';
            else if (file.mimetype?.includes('mp3') || file.mimetype?.includes('mpeg')) ext = '.mp3';
            else if (file.mimetype?.includes('wav')) ext = '.wav';
            else ext = '.mp4';
          }
          cb(null, uniqueSuffix + ext);
        },
      }),
    }),
  )
  async uploadAsset(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const ext = extname(file.originalname || file.filename).toLowerCase();
    let type = 'video';
    if (
      file.mimetype.startsWith('image/') ||
      ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico'].includes(ext)
    ) {
      type = 'image';
    } else if (
      file.mimetype.startsWith('audio/') ||
      ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext)
    ) {
      type = 'audio';
    } else {
      type = 'video';
    }

    let assetDuration = req.body?.duration ? parseFloat(req.body.duration) : 0;

    if (!assetDuration || isNaN(assetDuration) || assetDuration <= 0) {
      if (type === 'video' || type === 'audio') {
        try {
          assetDuration = await probeDuration(file.path);
        } catch (err) {
          console.error('Probe duration error:', err);
        }
      }
    }

    if (!assetDuration || isNaN(assetDuration) || assetDuration <= 0) {
      assetDuration = type === 'image' ? 5 : 10;
    }

    const host = req.headers['x-forwarded-host'] || req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const backendUrl =
      process.env.BACKEND_URL && !process.env.BACKEND_URL.includes('localhost')
        ? process.env.BACKEND_URL
        : `${protocol}://${host}`;
    const fileUrl = `${backendUrl}/uploads/${file.filename}`;

    const userId = req.user?.id;

    try {
      return await this.assetService.create({
        original_url: fileUrl,
        preview_url: fileUrl,
        duration: assetDuration,
        type: type,
        public_id: file.originalname || file.filename,
        userId,
      });
    } catch (error) {
      console.error('Upload DB save error:', error);
      throw new InternalServerErrorException('Failed to upload asset');
    }
  }

  @Get()
  async getAllAssets(@Req() req: any) {
    const userId = req.user?.id;
    return await this.assetService.findAll(userId);
  }

  @Delete(':id')
  async deleteAsset(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    return await this.assetService.delete(id, userId);
  }
}

@Controller('download')
export class DownloadController {
  @Get(':filename')
  downloadFile(@Param('filename') filename: string, @Res() res: express.Response) {
    const filePath = join(process.cwd(), 'uploads', filename);
    return res.download(filePath, filename, (err) => {
      if (err) {
        console.error('Download failed:', err);
        if (!res.headersSent) {
          res.status(404).send('File not found');
        }
      }
    });
  }
}
