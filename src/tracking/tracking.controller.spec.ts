import { Test, TestingModule } from '@nestjs/testing';
import { TrackingController } from './tracking.controller';
import { TrackingService, TRANSPARENT_GIF } from './tracking.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

// ── Mock TrackingService ──────────────────────────────────────────────────────
const mockTrackingService = {
  resolveToken: jest.fn(),
  geoCountry: jest.fn(),
  recordEvent: jest.fn(),
  isAllowedUrl: jest.fn(),
};

// ── Mock Express Response ─────────────────────────────────────────────────────
function mockRes() {
  const res: any = {};
  res.set = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}

// ── Mock Express Request ──────────────────────────────────────────────────────
function mockReq(ip = '1.2.3.4', forwarded?: string) {
  return {
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    socket: { remoteAddress: ip },
  } as any;
}

describe('TrackingController', () => {
  let controller: TrackingController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TrackingController],
      providers: [
        { provide: TrackingService, useValue: mockTrackingService },
      ],
    }).compile();

    controller = module.get<TrackingController>(TrackingController);
    jest.clearAllMocks();
  });

  // ── GET /t/o/:token ──────────────────────────────────────────────────────────

  describe('GET /t/o/:token (trackOpen)', () => {
    it('responds immediately with a 1×1 transparent GIF', async () => {
      mockTrackingService.resolveToken.mockResolvedValue({ id: 'msg-1' });
      mockTrackingService.geoCountry.mockReturnValue('PK');
      mockTrackingService.recordEvent.mockResolvedValue(undefined);

      const res = mockRes();
      await controller.trackOpen('valid-token', mockReq(), res);

      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({ 'Content-Type': 'image/gif' }),
      );
      expect(res.end).toHaveBeenCalledWith(TRANSPARENT_GIF);
    });

    it('still returns GIF even when token is invalid (no 404 to user)', async () => {
      // Pixel should always return GIF — we silently skip event recording
      mockTrackingService.resolveToken.mockResolvedValue(null);
      const res = mockRes();
      await controller.trackOpen('bad-token', mockReq(), res);
      expect(res.end).toHaveBeenCalledWith(TRANSPARENT_GIF);
    });

    it('sets cache-control headers to prevent caching', async () => {
      mockTrackingService.resolveToken.mockResolvedValue({ id: 'msg-1' });
      mockTrackingService.geoCountry.mockReturnValue(null);
      mockTrackingService.recordEvent.mockResolvedValue(undefined);

      const res = mockRes();
      await controller.trackOpen('tok', mockReq(), res);

      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Cache-Control': expect.stringContaining('no-store'),
        }),
      );
    });
  });

  // ── GET /t/c/:token ──────────────────────────────────────────────────────────

  describe('GET /t/c/:token (trackClick)', () => {
    it('redirects 302 to the destination URL for a valid token + allowed domain', async () => {
      mockTrackingService.resolveToken.mockResolvedValue({ id: 'msg-2' });
      mockTrackingService.isAllowedUrl.mockReturnValue(true);
      mockTrackingService.geoCountry.mockReturnValue('US');
      mockTrackingService.recordEvent.mockResolvedValue(undefined);

      const res = mockRes();
      await controller.trackClick('valid-token', 'https://example.com/offer', mockReq(), res);

      expect(res.redirect).toHaveBeenCalledWith(302, 'https://example.com/offer');
    });

    it('throws NotFoundException for an invalid token', async () => {
      mockTrackingService.resolveToken.mockResolvedValue(null);
      mockTrackingService.isAllowedUrl.mockReturnValue(true);

      const res = mockRes();
      await expect(
        controller.trackClick('bad-token', 'https://example.com', mockReq(), res),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for a disallowed domain', async () => {
      mockTrackingService.isAllowedUrl.mockReturnValue(false);

      const res = mockRes();
      await expect(
        controller.trackClick('valid-token', 'https://evil.com', mockReq(), res),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when url query param is missing', async () => {
      const res = mockRes();
      await expect(
        controller.trackClick('valid-token', undefined as any, mockReq(), res),
      ).rejects.toThrow(BadRequestException);
    });

    it('uses X-Forwarded-For IP when present (for geo lookup)', async () => {
      mockTrackingService.resolveToken.mockResolvedValue({ id: 'msg-3' });
      mockTrackingService.isAllowedUrl.mockReturnValue(true);
      mockTrackingService.geoCountry.mockReturnValue('DE');
      mockTrackingService.recordEvent.mockResolvedValue(undefined);

      const res = mockRes();
      const req = mockReq('10.0.0.1', '203.0.113.5, 10.0.0.1');
      await controller.trackClick('tok', 'https://example.com', req, res);

      // Flush the setImmediate fire-and-forget callback
      await new Promise<void>((resolve) => setImmediate(resolve));

      // geoCountry should be called with the leftmost (real client) IP
      expect(mockTrackingService.geoCountry).toHaveBeenCalledWith('203.0.113.5');
    });
  });
});
