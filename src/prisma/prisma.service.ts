import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../../prisma/generated/client/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * PrismaService wraps PrismaClient (Prisma v7) using the required pg driver adapter.
 * Uses composition rather than inheritance because Prisma 7's generated client
 * is ESM-first and cannot be extended via `class X extends PrismaClient`.
 *
 * Exposes `client` for raw access, plus convenience proxies for each model
 * so callers can write `this.prisma.event.create(...)` as expected.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;
  private readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    const adapter = new PrismaPg(this.pool);
    this.client = new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]);
  }

  async onModuleInit() {
    await (this.client as any).$connect();
  }

  async onModuleDestroy() {
    await (this.client as any).$disconnect();
    await this.pool.end();
  }

  // Model proxies — add more as new models are used across the app
  get workspace()   { return (this.client as any).workspace; }
  get audience()    { return (this.client as any).audience; }
  get contact()     { return (this.client as any).contact; }
  get campaign()    { return (this.client as any).campaign; }
  get message()     { return (this.client as any).message; }
  get event()       { return (this.client as any).event; }
  get suppression() { return (this.client as any).suppression; }
}
