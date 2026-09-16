import { Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

export interface CreateAssetInput {
  original_url: string;
  preview_url?: string;
  thumbnail_sprite_url?: string;
  duration?: number;
  type?: string;
  public_id?: string;
  userId: string;
}

@Injectable()
export class AssetService {
  constructor(private prisma: PrismaService) {}

  private mapAsset(asset: any) {
    if (!asset) return null;
    const { id, ...rest } = asset;
    return { _id: id, ...rest };
  }

  async create(data: CreateAssetInput) {
    if (!data.userId) {
      throw new UnauthorizedException('User authentication is required to create an asset');
    }

    const asset = await this.prisma.asset.create({
      data: {
        original_url: data.original_url,
        preview_url: data.preview_url || data.original_url,
        thumbnail_sprite_url: data.thumbnail_sprite_url,
        duration: data.duration,
        type: data.type || 'video',
        public_id: data.public_id,
        userId: data.userId,
      },
    });
    return this.mapAsset(asset);
  }

  async findAll(userId?: string) {
    if (!userId) {
      return [];
    }
    const assets = await this.prisma.asset.findMany({
      where: { userId },
      orderBy: {
        createdAt: 'desc',
      },
    });
    return assets.map((asset) => this.mapAsset(asset));
  }

  async delete(id: string, userId?: string) {
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const existing = await this.prisma.asset.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      throw new NotFoundException('Asset not found or you do not have permission to delete it');
    }

    // Attempt to delete physical file from disk
    try {
      if (existing.original_url && existing.original_url.includes('/uploads/')) {
        const rel = existing.original_url.split('/uploads/').pop()?.split('?')[0];
        if (rel) {
          const parts = rel.split('/').filter(Boolean);
          const filePath = path.join(process.cwd(), 'uploads', ...parts);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      }
    } catch (err) {
      console.warn('Could not delete physical asset file:', err);
    }

    const asset = await this.prisma.asset.delete({
      where: { id },
    });
    return this.mapAsset(asset);
  }
}
