import { Controller, Get, Post, Put, Body, Param, Req } from '@nestjs/common';
import { ProjectService } from './project.service';

@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  async createProject(@Body('title') title?: string, @Req() req?: any) {
    const userId = req?.user?.id;
    return await this.projectService.create(title || 'New Project', userId);
  }

  @Get()
  async getAllProjects(@Req() req: any) {
    const userId = req?.user?.id;
    return await this.projectService.findAll(userId);
  }

  @Get(':id')
  async getProject(@Param('id') id: string, @Req() req?: any) {
    const userId = req?.user?.id;
    return await this.projectService.findOne(id, userId);
  }

  @Put(':id/autosave')
  async autosaveProject(
    @Param('id') id: string,
    @Body('sceneGraph') sceneGraph: any,
    @Req() req?: any,
  ) {
    const userId = req?.user?.id;
    return await this.projectService.autosave(id, sceneGraph, userId);
  }
}
