import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    const pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 10000, // release idle connections before server drops them (Render/cloud Postgres)
      connectionTimeoutMillis: 10000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5000,
    });

    pool.on('error', (err) => {
      // Catch background socket drop errors from cloud PostgreSQL (Render/Supabase)
      // pg.Pool automatically removes the dead client from the pool
      Logger.warn(`Prisma pg pool idle connection closed by server: ${err.message}`, 'PrismaService');
    });

    const adapter = new PrismaPg(pool);
    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Prisma client connected with Pg adapter pool');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }
}

