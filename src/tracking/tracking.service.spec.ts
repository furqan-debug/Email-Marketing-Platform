import { Test, TestingModule } from '@nestjs/testing';
import { TrackingService } from './tracking.service';
import { PrismaService } from '../prisma/prisma.service';

// ── Mock PrismaService ────────────────────────────────────────────────────────
const mockPrisma = {
  message: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  event: {
    create: jest.fn(),
  },
};

describe('TrackingService', () => {
  let service: TrackingService;

  beforeEach(async () => {
    process.env.TRACKING_SECRET = 'test-secret-key-for-jest';
    process.env.TRACKING_ALLOWED_DOMAINS = 'digireps.co,example.com';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TrackingService>(TrackingService);
    jest.clearAllMocks();
  });

  // ── Token generation ────────────────────────────────────────────────────────

  describe('generateToken', () => {
    it('is deterministic — same messageId + secret always yields same token', () => {
      const t1 = service.generateToken('msg-abc-123');
      const t2 = service.generateToken('msg-abc-123');
      expect(t1).toBe(t2);
    });

    it('produces a different token for a different messageId', () => {
      const t1 = service.generateToken('msg-aaa');
      const t2 = service.generateToken('msg-bbb');
      expect(t1).not.toBe(t2);
    });

    it('produces a URL-safe base64 string (no +, /, or = chars)', () => {
      const token = service.generateToken('some-uuid-here');
      expect(token).not.toMatch(/[+/=]/);
      expect(token.length).toBeGreaterThan(10);
    });
  });

  // ── Token resolution ────────────────────────────────────────────────────────

  describe('resolveToken', () => {
    it('returns the message when token matches DB row', async () => {
      mockPrisma.message.findUnique.mockResolvedValue({ id: 'msg-123' });
      const result = await service.resolveToken('valid-token');
      expect(result).toEqual({ id: 'msg-123' });
      expect(mockPrisma.message.findUnique).toHaveBeenCalledWith({
        where: { trackingToken: 'valid-token' },
        select: { id: true },
      });
    });

    it('returns null when no message matches the token', async () => {
      mockPrisma.message.findUnique.mockResolvedValue(null);
      const result = await service.resolveToken('unknown-token');
      expect(result).toBeNull();
    });

    it('returns null for empty/invalid tokens without hitting DB', async () => {
      expect(await service.resolveToken('')).toBeNull();
      expect(await service.resolveToken(null as any)).toBeNull();
    });
  });

  // ── saveToken ────────────────────────────────────────────────────────────────

  describe('saveToken', () => {
    it('updates the Message row with the tracking token', async () => {
      mockPrisma.message.update.mockResolvedValue({});
      await service.saveToken('msg-123', 'tok-abc');
      expect(mockPrisma.message.update).toHaveBeenCalledWith({
        where: { id: 'msg-123' },
        data: { trackingToken: 'tok-abc' },
      });
    });
  });

  // ── geoCountry — privacy check ───────────────────────────────────────────────

  describe('geoCountry', () => {
    it('returns null for undefined IP', () => {
      expect(service.geoCountry(undefined)).toBeNull();
    });

    it('returns null for loopback IP (127.0.0.1)', () => {
      // geoip-lite returns null for private/loopback ranges
      expect(service.geoCountry('127.0.0.1')).toBeNull();
    });

    it('returns null for private range IP (192.168.x.x)', () => {
      expect(service.geoCountry('192.168.1.1')).toBeNull();
    });

    it('strips IPv6-mapped IPv4 prefix before lookup', () => {
      // ::ffff:127.0.0.1 → 127.0.0.1 → null (loopback)
      const result = service.geoCountry('::ffff:127.0.0.1');
      expect(result).toBeNull();
    });
  });

  // ── recordEvent ──────────────────────────────────────────────────────────────

  describe('recordEvent', () => {
    it('creates an Event with correct type, messageId, and country in rawPayload', async () => {
      mockPrisma.event.create.mockResolvedValue({});
      await service.recordEvent('msg-456', 'Open', { country: 'PK' });

      expect(mockPrisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'Open',
            messageId: 'msg-456',
            country: 'PK',
            rawPayload: { country: 'PK' },
          }),
        }),
      );
    });

    it('stores url in rawPayload for Click events', async () => {
      mockPrisma.event.create.mockResolvedValue({});
      await service.recordEvent('msg-789', 'Click', {
        country: 'US',
        url: 'https://example.com/promo',
      });

      expect(mockPrisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'Click',
            rawPayload: { country: 'US', url: 'https://example.com/promo' },
          }),
        }),
      );
    });

    it('omits country from rawPayload when country is null', async () => {
      mockPrisma.event.create.mockResolvedValue({});
      await service.recordEvent('msg-000', 'Open', { country: null });

      const call = mockPrisma.event.create.mock.calls[0][0];
      expect(call.data.rawPayload).not.toHaveProperty('country');
      expect(call.data.country).toBeUndefined();
    });
  });

  // ── wrapHtml ─────────────────────────────────────────────────────────────────

  describe('wrapHtml', () => {
    const token = 'abc123token';
    const baseUrl = 'https://app.example.com';

    it('injects a tracking pixel before </body>', () => {
      const html = '<html><body><p>Hello</p></body></html>';
      const result = service.wrapHtml(html, token, baseUrl);
      expect(result).toContain(`<img src="${baseUrl}/t/o/${token}"`);
      expect(result).toContain('</body>');
      expect(result.indexOf(`/t/o/${token}`)).toBeLessThan(result.indexOf('</body>'));
    });

    it('appends pixel if </body> is absent', () => {
      const html = '<p>No body tag</p>';
      const result = service.wrapHtml(html, token, baseUrl);
      expect(result).toContain(`/t/o/${token}`);
    });

    it('wraps <a href="..."> links with click-redirect URL', () => {
      const html = '<a href="https://digireps.co/offer">Click me</a></body>';
      const result = service.wrapHtml(html, token, baseUrl);
      const encoded = encodeURIComponent('https://digireps.co/offer');
      expect(result).toContain(`href="${baseUrl}/t/c/${token}?url=${encoded}"`);
    });

    it('wraps multiple links independently', () => {
      const html =
        '<a href="https://example.com/a">A</a><a href="https://example.com/b">B</a></body>';
      const result = service.wrapHtml(html, token, baseUrl);
      expect(result).toContain(encodeURIComponent('https://example.com/a'));
      expect(result).toContain(encodeURIComponent('https://example.com/b'));
    });
  });

  // ── isAllowedUrl ─────────────────────────────────────────────────────────────

  describe('isAllowedUrl', () => {
    it('allows URLs matching configured domains', () => {
      expect(service.isAllowedUrl('https://digireps.co/page')).toBe(true);
      expect(service.isAllowedUrl('https://example.com')).toBe(true);
    });

    it('allows subdomains of configured domains', () => {
      expect(service.isAllowedUrl('https://app.digireps.co/path')).toBe(true);
    });

    it('rejects URLs for unlisted domains', () => {
      expect(service.isAllowedUrl('https://evil.com/steal')).toBe(false);
    });

    it('rejects malformed URLs', () => {
      expect(service.isAllowedUrl('not-a-url')).toBe(false);
    });

    it('allows all URLs when TRACKING_ALLOWED_DOMAINS is empty (dev mode)', () => {
      const original = process.env.TRACKING_ALLOWED_DOMAINS;
      process.env.TRACKING_ALLOWED_DOMAINS = '';
      expect(service.isAllowedUrl('https://any-domain.io')).toBe(true);
      process.env.TRACKING_ALLOWED_DOMAINS = original;
    });
  });
});
