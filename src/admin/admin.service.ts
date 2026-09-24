import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { WorkerRegistryService } from '../rendering/worker-registry.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workerRegistry: WorkerRegistryService,
  ) {}

  async getStats() {
    const totalUsers = await this.prisma.user.count();
    const totalProjects = await this.prisma.project.count();
    const totalAssets = await this.prisma.asset.count();
    const totalVersions = await this.prisma.projectVersion.count();

    const usersByRole = await this.prisma.user.groupBy({
      by: ['role'],
      _count: { id: true },
    });

    const roleCounts: Record<string, number> = {
      USER: 0,
      ADMIN: 0,
      SUPER_ADMIN: 0,
    };

    usersByRole.forEach((group) => {
      roleCounts[group.role] = group._count.id;
    });

    return {
      totalUsers,
      totalProjects,
      totalAssets,
      totalVersions,
      roleCounts,
    };
  }

  async getAllUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
        _count: {
          select: {
            projects: true,
            assets: true,
          },
        },
      },
    });

    return users.map((u) => ({
      _id: u.id,
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      role: u.role,
      createdAt: u.createdAt,
      projectCount: u._count.projects,
      assetCount: u._count.assets,
    }));
  }

  async updateUserRole(targetUserId: string, newRole: UserRole, currentUserId: string) {
    if (targetUserId === currentUserId && newRole !== 'SUPER_ADMIN') {
      throw new BadRequestException('You cannot demote yourself from SUPER_ADMIN');
    }

    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { role: newRole },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });

    return {
      message: `User ${updated.email} role updated to ${updated.role}`,
      user: {
        _id: updated.id,
        ...updated,
      },
    };
  }

  async deleteUser(targetUserId: string, currentUserId: string) {
    if (targetUserId === currentUserId) {
      throw new BadRequestException('You cannot delete your own account via Admin panel');
    }

    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.prisma.user.delete({ where: { id: targetUserId } });

    return {
      message: `User ${user.email} and all associated data deleted successfully`,
    };
  }

  // --- Distributed Rendering Cluster & Logs (Admin Only) ---

  async getRenderingNodes() {
    return this.workerRegistry.getStats();
  }

  async getRenderingLogs(query?: { eventType?: string; level?: string; workerId?: string; limit?: number }) {
    return {
      total: this.workerRegistry.getLogs().length,
      logs: this.workerRegistry.getLogs(query),
    };
  }

  async clearRenderingLogs() {
    this.workerRegistry.clearLogs();
    return { message: 'Cluster activity logs cleared successfully' };
  }
}
