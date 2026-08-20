import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AnalyticsService } from './analytics.service';

/**
 * Scheduled job that aggregates Event rows into AnalyticsSnapshot rows.
 *
 * Cadence is controlled by the ANALYTICS_CRON environment variable
 * (default: every 15 minutes). The cron expression is read at startup.
 *
 * The job runs in-process via @nestjs/schedule — no BullMQ queue needed
 * since analytics aggregation is a low-frequency background operation.
 */
@Injectable()
export class AnalyticsScheduler {
  private readonly logger = new Logger(AnalyticsScheduler.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Runs on the schedule defined by ANALYTICS_CRON (default: every 15 min).
   * Uses a dynamic expression so the cadence can be changed without code changes.
   */
  @Cron(process.env['ANALYTICS_CRON'] ?? '*/15 * * * *')
  async handleCron(): Promise<void> {
    this.logger.log('Analytics aggregation cron triggered');
    try {
      const result = await this.analyticsService.computeAll();
      this.logger.log(
        `Analytics cron complete — processed=${result.processed} duration=${result.durationMs}ms`,
      );
    } catch (err: any) {
      this.logger.error(`Analytics cron failed: ${err?.message ?? err}`);
    }
  }
}
