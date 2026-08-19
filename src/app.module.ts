import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AssetModule } from './asset/asset.module';
import { ProjectModule } from './project/project.module';
import { ExportModule } from './export/export.module';
import { RenderingModule } from './rendering/rendering.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    AssetModule,
    ProjectModule,
    ExportModule,
    RenderingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
