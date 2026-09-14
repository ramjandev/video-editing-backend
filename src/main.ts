import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'path';
import * as fs from 'fs';
import * as express from 'express';
import { configureFfmpeg } from './common/ffmpeg.util';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Trust proxy for Nginx / reverse proxy setup
  app.set('trust proxy', 1);

  // Increase payload limits for large video metadata and uploads
  app.use(express.json({ limit: '500mb' }));
  app.use(express.urlencoded({ limit: '500mb', extended: true }));

  // Set global API prefix
  app.setGlobalPrefix('api');

  // Enable CORS for all origins and network hosts
  app.enableCors({ origin: '*', credentials: false });

  // Global validation pipe — strips unknown fields, transforms types
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));

  // Auto-create uploads directory if it doesn't exist
  const uploadsDir = join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('Created uploads directory');
  }

  // Configure FFMPEG / FFPROBE binary paths with system fallback priority
  configureFfmpeg();

  // Serve static uploads with CORS headers enabled for media elements
  app.useStaticAssets(uploadsDir, {
    prefix: '/uploads',
    setHeaders: (res) => {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.set('Access-Control-Allow-Headers', '*');
    },
  });

  // Configure Swagger OpenAPI Documentation
  const config = new DocumentBuilder()
    .setTitle('VideoStudio Pro API')
    .setDescription('Professional Video Editing, Render Time Estimation Engine & Distributed Cluster API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);
  SwaggerModule.setup('docs', app, document);

  // URL-rewriting middleware to handle local/VPS/network CORS environment mapping
  app.use((req: any, res: any, next: any) => {
    const originalJson = res.json;
    res.json = function (data: any) {
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const requestOrigin = `${protocol}://${host}`;

      let jsonString = JSON.stringify(data);
      if (jsonString) {
        jsonString = jsonString.replace(/http:\/\/localhost:3000/g, requestOrigin);
        if (process.env.BACKEND_URL && process.env.BACKEND_URL !== 'http://localhost:3000') {
          jsonString = jsonString.replaceAll(process.env.BACKEND_URL, requestOrigin);
        }
      }

      res.setHeader('Content-Type', 'application/json');
      return res.send(jsonString);
    };
    next();
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`✅ Server running on http://0.0.0.0:${port} (Network Access Enabled)`);
  console.log(`📚 Swagger OpenAPI Documentation available at http://localhost:${port}/api/docs`);
}
bootstrap();
