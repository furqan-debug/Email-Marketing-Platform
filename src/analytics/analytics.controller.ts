import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { AnalyticsService, AnalyticsResult } from './analytics.service';

/**
 * Analytics dashboard endpoints.
 *
 * All GET routes read exclusively from AnalyticsSnapshot — no live aggregation
 * ever runs at HTTP request time. Snapshots are populated by the cron job
 * (AnalyticsScheduler) or via the on-demand POST compute endpoint.
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * GET /analytics/campaigns/:id
   *
   * Returns the latest pre-computed snapshot for a campaign.
   * Includes computed rates (openRate, clickRate, etc.) and a staleWarning
   * flag that is true when the snapshot is older than 30 minutes.
   *
   * Never queries the Event table.
   */
  @Get('campaigns/:id')
  getSnapshot(@Param('id') id: string): Promise<AnalyticsResult> {
    return this.analyticsService.getSnapshot(id);
  }

  /**
   * POST /analytics/campaigns/:id/compute
   *
   * Triggers an immediate on-demand aggregation for a single campaign.
   * Useful for testing and for manual refresh outside the cron schedule.
   * Upserts the snapshot atomically — safe to call concurrently.
   */
  @Post('campaigns/:id/compute')
  @HttpCode(200)
  computeSnapshot(@Param('id') id: string): Promise<AnalyticsResult> {
    return this.analyticsService.computeForCampaign(id);
  }

  /**
   * GET /analytics/campaigns/:id/activity
   * Returns recent real-time engagement activity for a campaign.
   */
  @Get('campaigns/:id/activity')
  getActivity(@Param('id') id: string) {
    return this.analyticsService.getRecentActivity(id);
  }
}


