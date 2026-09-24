import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { RenderingModule } from '../rendering/rendering.module';

@Module({
  imports: [PrismaModule, AuthModule, RenderingModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
