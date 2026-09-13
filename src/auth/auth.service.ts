import { Injectable, ConflictException, UnauthorizedException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async onModuleInit() {
    await this.seedSuperAdmin();
  }

  private async seedSuperAdmin() {
    try {
      const email = (process.env.SUPER_ADMIN_EMAIL || 'admin@videostudio.com').toLowerCase().trim();
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (!existing) {
        const hashedPassword = await bcrypt.hash('Admin123!', 10);
        await this.prisma.user.create({
          data: {
            firstName: 'Super',
            lastName: 'Admin',
            email,
            password: hashedPassword,
            role: 'SUPER_ADMIN',
          },
        });
        console.log(`[AuthService] Auto-seeded default Super Admin: ${email} / Admin123!`);
      }
    } catch (err: any) {
      console.error('[AuthService] Failed to seed default Super Admin:', err?.message || err);
    }
  }

  async register(dto: RegisterDto) {
    const emailNormalized = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({
      where: { email: emailNormalized },
    });

    if (existing) {
      throw new ConflictException('User with this email already exists');
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(dto.password, salt);

    // Auto-promote to SUPER_ADMIN if first user or matches SUPER_ADMIN_EMAIL env
    const userCount = await this.prisma.user.count();
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL?.toLowerCase().trim();
    let initialRole: 'USER' | 'ADMIN' | 'SUPER_ADMIN' = 'USER';
    if (userCount === 0 || (superAdminEmail && emailNormalized === superAdminEmail)) {
      initialRole = 'SUPER_ADMIN';
    }

    const user = await this.prisma.user.create({
      data: {
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        email: emailNormalized,
        password: hashedPassword,
        role: initialRole,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        createdAt: true,
      },
    });

    const token = this.generateToken(user.id, user.email);

    return {
      message: 'Registration successful',
      user: {
        _id: user.id,
        ...user,
      },
      token,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const token = this.generateToken(user.id, user.email);

    const { password, ...safeUser } = user;

    return {
      message: 'Login successful',
      user: {
        _id: safeUser.id,
        ...safeUser,
      },
      token,
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User profile not found');
    }

    return {
      _id: user.id,
      ...user,
    };
  }

  private generateToken(userId: string, email: string): string {
    const payload = { sub: userId, email };
    return this.jwtService.sign(payload);
  }
}
