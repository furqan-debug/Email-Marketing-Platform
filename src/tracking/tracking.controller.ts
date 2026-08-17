import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { TrackingService, TRANSPARENT_GIF } from './tracking.service';

@Controller('t')
export class TrackingController {
  private readonly logger = new Logger(TrackingController.name);

  constructor(private readonly trackingService: TrackingService) {}

  /**
   * Tracking pixel endpoint.
   * Returns a 1×1 transparent GIF and records an Open event.
   * Privacy: IP is used only to derive country, then discarded.
   */
  @Get('o/:token')
  async trackOpen(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Always return the pixel immediately — never let tracking logic block the response
    res.set({
      'Content-Type': 'image/gif',
      'Content-Length': TRANSPARENT_GIF.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(TRANSPARENT_GIF);

    // Fire-and-forget: record event after response is sent
    setImmediate(async () => {
      try {
        const message = await this.trackingService.resolveToken(token);
        if (!message) {
          this.logger.warn(`trackOpen: unknown token ${token}`);
          return;
        }
        const ip = this.extractIp(req);
        const country = this.trackingService.geoCountry(ip);
        // IP is NOT stored — only country
        await this.trackingService.recordEvent(message.id, 'Open', { country });
      } catch (err: any) {
        this.logger.error(`trackOpen error: ${err?.message ?? err}`);
      }
    });
  }

  /**
   * Click-redirect endpoint.
   * Records a Click event then 302-redirects to the destination URL.
   * Privacy: IP is used only to derive country, then discarded.
   */
  @Get('c/:token')
  async trackClick(
    @Param('token') token: string,
    @Query('url') url: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!url) {
      throw new BadRequestException('url query parameter is required');
    }

    // Validate destination domain against allowlist
    if (!this.trackingService.isAllowedUrl(url)) {
      throw new BadRequestException('Redirect destination is not allowed');
    }

    const message = await this.trackingService.resolveToken(token);
    if (!message) {
      throw new NotFoundException('Invalid or expired tracking token');
    }

    // Redirect immediately
    res.redirect(302, url);

    // Fire-and-forget event recording after redirect is sent
    setImmediate(async () => {
      try {
        const ip = this.extractIp(req);
        const country = this.trackingService.geoCountry(ip);
        // IP discarded — only country and destination URL stored
        await this.trackingService.recordEvent(message.id, 'Click', {
          country,
          url, // destination URL is non-personal metadata
        });
      } catch (err: any) {
        this.logger.error(`trackClick error: ${err?.message ?? err}`);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract the real client IP, respecting X-Forwarded-For from trusted proxies
   * (ngrok, load balancers). The returned IP is used ONLY for geo lookup and
   * is immediately discarded — never logged or stored.
   */
  private extractIp(req: Request): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      // X-Forwarded-For: client, proxy1, proxy2 — take leftmost (real client)
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return first.split(',')[0].trim();
    }
    return req.socket?.remoteAddress;
  }
}
