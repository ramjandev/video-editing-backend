import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  // Set global API prefix
  app.setGlobalPrefix('api');

  // Enable CORS
  app.enableCors();

  // Serve static uploads
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads',
  });

  // URL-rewriting middleware to handle local/VPS CORS environment mapping
  app.use((req: any, res: any, next: any) => {
    const originalJson = res.json;
    res.json = function (data: any) {
      const host = req.get('host');
      const protocol = req.protocol;
      const requestOrigin = `${protocol}://${host}`;
      
      let jsonString = JSON.stringify(data);
      if (jsonString) {
        // Replace localhost:3000 URLs with the actual request origin
        jsonString = jsonString.replace(/http:\/\/localhost:3000/g, requestOrigin);
        
        // Also replace BACKEND_URL from env if it is set to something else
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
  await app.listen(port);
  console.log(`Server running on port ${port}`);
}
bootstrap();
