import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getStats() {
    return this.adminService.getStats();
  }

  @Get('users')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getAllUsers() {
    return this.adminService.getAllUsers();
  }

  @Patch('users/:id/role')
  @Roles('SUPER_ADMIN')
  async updateUserRole(
    @Param('id') id: string,
    @Body('role') role: UserRole,
    @Req() req: any,
  ) {
    if (!role || !['USER', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      throw new BadRequestException('Invalid role. Allowed values: USER, ADMIN, SUPER_ADMIN');
    }
    return this.adminService.updateUserRole(id, role, req.user.id);
  }

  @Delete('users/:id')
  @Roles('SUPER_ADMIN')
  async deleteUser(@Param('id') id: string, @Req() req: any) {
    return this.adminService.deleteUser(id, req.user.id);
  }

  // --- Distributed Render Cluster & Logs (Admin Only) ---

  @Get('rendering/nodes')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getRenderingNodes() {
    return this.adminService.getRenderingNodes();
  }

  @Get('rendering/logs')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getRenderingLogs(
    @Query('eventType') eventType?: string,
    @Query('level') level?: string,
    @Query('workerId') workerId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getRenderingLogs({
      eventType,
      level,
      workerId,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('rendering/clear-logs')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async clearRenderingLogs() {
    return this.adminService.clearRenderingLogs();
  }
}
