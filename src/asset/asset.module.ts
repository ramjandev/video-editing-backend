import { Module } from '@nestjs/common';
import { AssetController, DownloadController } from './asset.controller';
import { AssetService } from './asset.service';

@Module({
  controllers: [AssetController, DownloadController],
  providers: [AssetService]
})
export class AssetModule {}
