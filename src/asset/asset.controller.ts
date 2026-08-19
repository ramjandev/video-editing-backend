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
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegStatic from 'ffmpeg-static';
import * as ffprobeStatic from 'ffprobe-static';
import { AssetService } from './asset.service';

// Configure FFMPEG paths
ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const probeDuration = (filePath: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format.duration;
      resolve(duration || 0);
    });
  });
};

@Controller('assets')
export class AssetController {
  constructor(private readonly assetService: AssetService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('video', {
      storage: diskStorage({
        destination: join(process.cwd(), 'uploads'),
        filename: (req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          cb(null, uniqueSuffix + extname(file.originalname));
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

    let type = 'video';
    if (file.mimetype.startsWith('image/')) type = 'image';
    if (file.mimetype.startsWith('audio/')) type = 'audio';

    let assetDuration = 0;
    if (type === 'video' || type === 'audio') {
      try {
        assetDuration = await probeDuration(file.path);
      } catch (err) {
        console.error('Probe duration error:', err);
      }
    } else {
      assetDuration = 5; // Default image duration
    }

    const host = req.get('host');
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
