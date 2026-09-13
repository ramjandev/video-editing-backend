import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  Param,
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
}
