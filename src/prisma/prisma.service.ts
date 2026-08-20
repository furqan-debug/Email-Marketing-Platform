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
    const connectionString =
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.DATABASE_PUBLIC_URL ||
      process.env.DATABASE_PRIVATE_URL;

    // AWS RDS (and most remote databases) require SSL.
    // Disable SSL only for localhost / 127.0.0.1 (local dev).
    const isLocal =
      connectionString?.includes('localhost') ||
      connectionString?.includes('127.0.0.1');

    this.pool = new Pool({
      connectionString,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
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
  get workspace()         { return (this.client as any).workspace; }
  get audience()          { return (this.client as any).audience; }
  get contact()           { return (this.client as any).contact; }
  get campaign()          { return (this.client as any).campaign; }
  get message()           { return (this.client as any).message; }
  get event()             { return (this.client as any).event; }
  get suppression()       { return (this.client as any).suppression; }
  get template()          { return (this.client as any).template; }
  get analyticsSnapshot() { return (this.client as any).analyticsSnapshot; }
  get workflowExecution() { return (this.client as any).workflowExecution; }
}
