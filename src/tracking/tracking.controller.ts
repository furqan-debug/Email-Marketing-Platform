import {
  Controller,
  Get,
  Post,
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
import { ContactsService } from '../contacts/contacts.service';

@Controller('t')
export class TrackingController {
  private readonly logger = new Logger(TrackingController.name);

  constructor(
    private readonly trackingService: TrackingService,
    private readonly contactsService: ContactsService,
  ) {}

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

  /**
   * GET /t/unsub/:token (also accessible as /unsubscribe/:token via alias controller)
   * Resolves the tracking token to find the contact, suppresses them in their
   * workspace, and returns a plain HTML confirmation page.
   * Always returns 200 — never exposes an error page to the recipient.
   */
  @Get('unsub/:token')
  async unsubscribe(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const okHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9f9f9;}
.card{background:#fff;border-radius:12px;padding:40px;max-width:400px;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,.08);}
h1{font-size:1.4rem;color:#333;}p{color:#666;}</style>
</head>
<body><div class="card">
<h1>You have been unsubscribed</h1>
<p>You will no longer receive marketing emails from us.<br>If this was a mistake, please contact us directly.</p>
</div></body></html>`;

    const neutralHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Unsubscribed</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;">
<h2>Already unsubscribed or link is no longer valid.</h2>
<p>You are already opted out, or this link has expired.</p>
</body></html>`;

    try {
      const message = await this.trackingService.resolveToken(token);
      if (!message) {
        res.status(200).set('Content-Type', 'text/html').send(neutralHtml);
        return;
      }

      // Resolve contact + workspace via message → campaign → audience
      const fullMessage = await this.trackingService.getMessageWithWorkspace(message.id);
      if (!fullMessage) {
        res.status(200).set('Content-Type', 'text/html').send(neutralHtml);
        return;
      }

      await this.contactsService.suppress(
        fullMessage.workspaceId,
        fullMessage.email,
      );
      this.logger.log(`Unsubscribed ${fullMessage.email} from workspace ${fullMessage.workspaceId} via token`);
    } catch (err: any) {
      this.logger.error(`Unsubscribe error: ${err?.message ?? err}`);
    }

    res.status(200).set('Content-Type', 'text/html').send(okHtml);
  }

  /**
   * POST /t/unsub/:token
   * RFC 8058 one-click unsubscribe — Gmail calls this when the user clicks the
   * blue "Unsubscribe" link in the email header (List-Unsubscribe-Post: List-Unsubscribe=One-Click).
   * Must return 200 with no redirect.
   */
  @Post('unsub/:token')
  async unsubscribeOneClick(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const message = await this.trackingService.resolveToken(token);
      if (message) {
        const fullMessage = await this.trackingService.getMessageWithWorkspace(message.id);
        if (fullMessage) {
          await this.contactsService.suppress(
            fullMessage.workspaceId,
            fullMessage.email,
          );
          this.logger.log(
            `[OneClick] Unsubscribed ${fullMessage.email} from workspace ${fullMessage.workspaceId}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.error(`[OneClick] Unsubscribe error: ${err?.message ?? err}`);
    }
    // RFC 8058 requires 200 OK with no body for one-click
    res.status(200).send('');
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
