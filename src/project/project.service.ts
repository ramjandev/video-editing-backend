import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProjectService {
  constructor(private prisma: PrismaService) {}

  private mapProject(project: any) {
    if (!project) return null;
    const { id, ...rest } = project;
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

  async create(title: string, userId?: string) {
    let resolvedUserId = userId;
    if (!resolvedUserId) {
      resolvedUserId = await this.getOrCreateDefaultUser();
    } else {
      const userExists = await this.prisma.user.findUnique({ where: { id: resolvedUserId } });
      if (!userExists) {
        resolvedUserId = await this.getOrCreateDefaultUser();
      }
    }

    const project = await this.prisma.project.create({
      data: {
        title: title || 'Untitled Project',
        resolution: { w: 1920, h: 1080 },
        userId: resolvedUserId,
      },
    });

    const initialSceneGraph = {
      projectId: project.id,
      duration: 0.0,
      fps: 30,
      resolution: { w: 1920, h: 1080 },
      tracks: [
        { id: 'track_1', type: 'video', clips: [] },
        { id: 'track_2', type: 'audio', clips: [] },
      ],
    };

    await this.prisma.projectVersion.create({
      data: {
        projectId: project.id,
        versionNum: 1,
        sceneGraph: initialSceneGraph,
      },
    });

    return {
      project: this.mapProject(project),
      sceneGraph: initialSceneGraph,
    };
  }

  async findAll(userId?: string) {
    const whereClause = userId ? { userId } : {};
    const projects = await this.prisma.project.findMany({
      where: whereClause,
      orderBy: { updatedAt: 'desc' },
      include: {
        versions: {
          orderBy: { versionNum: 'desc' },
          take: 1,
        },
      },
    });

    return projects.map((p) => ({
      ...this.mapProject(p),
      latestVersion: p.versions[0]?.versionNum || 1,
    }));
  }

  async findOne(id: string, userId?: string) {
    const whereClause: any = { id };
    if (userId) {
      // Optional check or permission check
    }

    const project = await this.prisma.project.findUnique({
      where: whereClause,
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const latestVersion = await this.prisma.projectVersion.findFirst({
      where: { projectId: id },
      orderBy: { versionNum: 'desc' },
    });

    return {
      project: this.mapProject(project),
      sceneGraph: latestVersion ? latestVersion.sceneGraph : null,
    };
  }

  async autosave(projectId: string, sceneGraph: any, userId?: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Find the latest version number
    const latestVersion = await this.prisma.projectVersion.findFirst({
      where: { projectId },
      orderBy: { versionNum: 'desc' },
    });

    const nextVersionNum = latestVersion ? latestVersion.versionNum + 1 : 1;

    // Make sure the sceneGraph has the correct projectId
    if (sceneGraph) {
      sceneGraph.projectId = projectId;
    }

    await this.prisma.projectVersion.create({
      data: {
        projectId,
        versionNum: nextVersionNum,
        sceneGraph: sceneGraph,
      },
    });

    // Update project updatedAt
    await this.prisma.project.update({
      where: { id: projectId },
      data: { updatedAt: new Date(), duration: sceneGraph?.duration || project.duration },
    });

    return {
      message: 'Autosaved successfully',
      version: nextVersionNum,
    };
  }
}
