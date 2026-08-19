import { Module, forwardRef } from '@nestjs/common';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { RenderingModule } from '../rendering/rendering.module';

@Module({
  imports: [forwardRef(() => RenderingModule)],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
