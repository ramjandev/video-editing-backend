import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateAssetInput {
  original_url: string;
  preview_url?: string;
  thumbnail_sprite_url?: string;
  duration?: number;
  type?: string;
  public_id?: string;
  userId?: string;
}

@Injectable()
export class AssetService {
  constructor(private prisma: PrismaService) {}

  private mapAsset(asset: any) {
    if (!asset) return null;
    const { id, ...rest } = asset;
    return { _id: id, ...rest };
  }

  private async getOrCreateDefaultUser(): Promise<string> {
    const existing = await this.prisma.user.findFirst();
    if (existing) return existing.id;

    const defaultUser = await this.prisma.user.create({
      data: {
        firstName: 'Video',
        lastName: 'Creator',
        email: 'creator@editor.local',
        password: '$2b$10$hasheddefaultpasswordforapp123456789',
      },
    });
    return defaultUser.id;
  }

  async create(data: CreateAssetInput) {
    let resolvedUserId = data.userId;
    if (!resolvedUserId) {
      resolvedUserId = await this.getOrCreateDefaultUser();
    } else {
      const userExists = await this.prisma.user.findUnique({ where: { id: resolvedUserId } });
      if (!userExists) {
        resolvedUserId = await this.getOrCreateDefaultUser();
      }
    }

    const asset = await this.prisma.asset.create({
      data: {
        original_url: data.original_url,
        preview_url: data.preview_url || data.original_url,
        thumbnail_sprite_url: data.thumbnail_sprite_url,
        duration: data.duration,
        type: data.type || 'video',
        public_id: data.public_id,
        userId: resolvedUserId,
      },
    });
    return this.mapAsset(asset);
  }

  async findAll(userId?: string) {
    const whereClause = userId ? { userId } : {};
    const assets = await this.prisma.asset.findMany({
      where: whereClause,
      orderBy: {
        createdAt: 'desc',
      },
    });
    return assets.map((asset) => this.mapAsset(asset));
  }

  async delete(id: string, userId?: string) {
    const whereClause: any = { id };
    if (userId) {
      whereClause.userId = userId;
    }
    const asset = await this.prisma.asset.delete({
      where: whereClause,
    });
    return this.mapAsset(asset);
  }
}
