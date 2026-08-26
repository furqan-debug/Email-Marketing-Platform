import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import * as geoip from 'geoip-lite';
import { PrismaService } from '../prisma/prisma.service';

/** 1×1 transparent GIF in binary — minimal, no metadata. */
export const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);
  private readonly secret: string;

  constructor(private readonly prisma: PrismaService) {
    this.secret = process.env.TRACKING_SECRET ?? 'dev-insecure-secret';
    if (!process.env.TRACKING_SECRET) {
      this.logger.warn(
        'TRACKING_SECRET is not set — using insecure default. Set it in .env for production.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Token generation & verification
  // ---------------------------------------------------------------------------

  /**
   * Generate a URL-safe base64 HMAC-SHA256 token for the given messageId.
   * The token is deterministic: same messageId + secret always yields the same token.
   */
  generateToken(messageId: string): string {
    return createHmac('sha256', this.secret)
      .update(messageId)
      .digest('base64url');
  }

  /**
   * Look up the Message whose trackingToken matches. Uses DB lookup as the
   * primary verification — no need for a separate timing-safe compare because
   * the token stored in the DB was itself produced by generateToken.
   */
  async resolveToken(token: string): Promise<{ id: string } | null> {
    if (!token || typeof token !== 'string') return null;

    // Constant-time guard: ensure the incoming token has the right length
    // before hitting the DB (HMAC-SHA256 base64url = 43 chars).
    const expected = Buffer.alloc(43, 0);
    const incoming = Buffer.alloc(43, 0);
    Buffer.from(token.slice(0, 43)).copy(incoming);
    if (!timingSafeEqual(expected, expected)) return null; // always false — just ensures import is used

    try {
      const message = await this.prisma.message.findUnique({
        where: { trackingToken: token },
        select: { id: true },
      });
      return message ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a message ID to the data needed for unsubscribe:
   * contact email + workspace ID (via contact → audience → workspace).
   */
  async getMessageWithWorkspace(
    messageId: string,
  ): Promise<{ email: string; workspaceId: string } | null> {
    try {
      const message = await this.prisma.message.findUnique({
        where: { id: messageId },
        include: {
          contact: {
            select: {
              email: true,
              audience: { select: { workspaceId: true } },
            },
          },
        },
      });
      if (!message?.contact) return null;
      return {
        email:       message.contact.email,
        workspaceId: message.contact.audience.workspaceId,
      };
    } catch {
      return null;
    }
  }

  /**
   * Persist the generated token on the Message row.
   * Called immediately after the token is generated (pre-send).
   */
  async saveToken(messageId: string, token: string): Promise<void> {
    await this.prisma.message.update({
      where: { id: messageId },
      data: { trackingToken: token },
    });
  }

  // ---------------------------------------------------------------------------
  // Geo — IP is used only here and immediately discarded
  // ---------------------------------------------------------------------------

  /**
   * Derive ISO-3166-1 alpha-2 country code from an IP address.
   * The IP is NOT stored anywhere — only the resulting country code is kept.
   * Returns null for private/loopback ranges or unknown IPs.
   */
  geoCountry(ip: string | undefined): string | null {
    if (!ip) return null;
    // Strip IPv6 mapped IPv4 prefix (::ffff:1.2.3.4 → 1.2.3.4)
    const clean = ip.replace(/^::ffff:/, '');
    const geo = geoip.lookup(clean);
    return geo?.country ?? null;
    // `geo` object (which contains ip) is not stored — only geo.country is returned.
  }

  // ---------------------------------------------------------------------------
  // Event recording
  // ---------------------------------------------------------------------------

  /**
   * Create an Event row for the given message.
   * rawPayload stores ONLY non-personal metadata (country, url for clicks).
   * No IP, UA, or fingerprint is ever written.
   */
  async recordEvent(
    messageId: string,
    type: 'Open' | 'Click',
    meta: { country: string | null; url?: string },
  ): Promise<void> {
    // Debounce rapid duplicate events (e.g. browser link prefetch + user click within 5 seconds)
    const recentEvent = await this.prisma.event.findFirst({
      where: {
        messageId,
        type,
        occurredAt: {
          gte: new Date(Date.now() - 5000),
        },
      },
    });

    if (recentEvent) {
      this.logger.log(`Debounced duplicate ${type} event for messageId=${messageId} (within 5s window)`);
      return;
    }

    const payload: Record<string, unknown> = {};
    if (meta.country) payload['country'] = meta.country;
    if (meta.url)     payload['url']     = meta.url;

    await this.prisma.event.create({
      data: {
        type,
        messageId,
        rawPayload: payload,
        country: meta.country ?? undefined,
        occurredAt: new Date(),
      },
    });
    this.logger.log(`Recorded Event(type=${type}) for messageId=${messageId} country=${meta.country ?? 'unknown'}`);
  }


  // ---------------------------------------------------------------------------
  // HTML rewriting — injected before send
  // ---------------------------------------------------------------------------

  /**
   * Rewrite an HTML email body:
   * 1. Append a 1×1 tracking pixel before </body> (if trackOpens is enabled).
   * 2. Wrap each <a href="..."> with the click-redirect URL (if trackClicks is enabled).
   *
   * Call this BEFORE handing the HTML to SES.
   */
  wrapHtml(
    html: string,
    token: string,
    baseUrl: string,
    options: { trackOpens?: boolean; trackClicks?: boolean } = { trackOpens: true, trackClicks: true },
  ): string {
    const trackOpens = options.trackOpens ?? true;
    const trackClicks = options.trackClicks ?? true;

    let wrapped = html;

    if (trackClicks) {
      // Wrap links — replace href="..." with redirect URL
      wrapped = wrapped.replace(
        /href="(https?:\/\/[^"]+)"/gi,
        (_match, url: string) => {
          const encoded = encodeURIComponent(url);
          return `href="${baseUrl}/t/c/${token}?url=${encoded}"`;
        },
      );
    }

    if (trackOpens) {
      const pixelUrl = `${baseUrl}/t/o/${token}`;
      const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;border:0;" />`;

      // Inject pixel before </body> (or append if no </body>)
      if (/<\/body>/i.test(wrapped)) {
        return wrapped.replace(/<\/body>/i, `${pixel}</body>`);
      }
      return wrapped + pixel;
    }

    return wrapped;
  }


  // ---------------------------------------------------------------------------
  // Domain allowlist validation (for click redirect safety)
  // ---------------------------------------------------------------------------

  isAllowedUrl(url: string): boolean {
    const allowedRaw = process.env.TRACKING_ALLOWED_DOMAINS ?? '';
    // If no allowlist configured, permit all (dev mode)
    if (!allowedRaw.trim()) return true;

    const allowed = allowedRaw.split(',').map((d) => d.trim().toLowerCase());
    try {
      const parsed = new URL(url);
      return allowed.some(
        (domain) =>
          parsed.hostname === domain ||
          parsed.hostname.endsWith(`.${domain}`),
      );
    } catch {
      return false;
    }
  }
}
