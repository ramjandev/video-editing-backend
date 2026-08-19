import { Module, forwardRef } from '@nestjs/common';
import { RenderingGateway } from './rendering.gateway';
import { RenderingService } from './rendering.service';
import { WorkerRegistryService } from './worker-registry.service';
import { RenderingController } from './rendering.controller';
import { ExportModule } from '../export/export.module';

@Module({
  imports: [forwardRef(() => ExportModule)],
  controllers: [RenderingController],
  providers: [RenderingGateway, RenderingService, WorkerRegistryService],
  exports: [RenderingGateway, RenderingService, WorkerRegistryService],
})
export class RenderingModule {}
