import { Test, TestingModule } from '@nestjs/testing';
import { ContactsService } from './contacts.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';

// ── Mock PrismaService ────────────────────────────────────────────────────────
const mockUpsert = jest.fn();
const mockFindUnique = jest.fn();
const mockDelete = jest.fn();

const mockPrisma = {
  audience: { findUnique: jest.fn() },
  contact:  { upsert: mockUpsert },
  suppression: {
    upsert:     mockUpsert,       // reused for simplicity — overridden per test
    findUnique: mockFindUnique,
    delete:     mockDelete,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function csv(...rows: string[]): Buffer {
  return Buffer.from(['email', ...rows].join('\n'));
}

function csvWithHeader(header: string, ...rows: string[]): Buffer {
  return Buffer.from([header, ...rows].join('\n'));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ContactsService', () => {
  let service: ContactsService;

  // Separate mock fns per model to avoid collision
  const contactUpsert = jest.fn();
  const suppressionUpsert = jest.fn();
  const suppressionFindUnique = jest.fn();
  const suppressionDelete = jest.fn();
  const audienceFindUnique = jest.fn();

  const prismaFull = {
    audience:    { findUnique: audienceFindUnique },
    contact:     { upsert: contactUpsert },
    suppression: {
      upsert:     suppressionUpsert,
      findUnique: suppressionFindUnique,
      delete:     suppressionDelete,
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactsService,
        { provide: PrismaService, useValue: prismaFull },
      ],
    }).compile();

    service = module.get<ContactsService>(ContactsService);
    jest.clearAllMocks();

    // Default: audience exists
    audienceFindUnique.mockResolvedValue({ id: 'aud-1' });
  });

  // ── importCsv ────────────────────────────────────────────────────────────────

  describe('importCsv', () => {
    it('imports new contacts and returns correct counts', async () => {
      contactUpsert.mockResolvedValue({ id: 'c1', email: 'a@example.com', audienceId: 'aud-1' });

      const result = await service.importCsv(
        'aud-1',
        csv('a@example.com', 'b@example.com'),
      );

      expect(contactUpsert).toHaveBeenCalledTimes(2);
      expect(result.imported).toBe(2);
      expect(result.errors).toBe(0);
    });

    it('normalises email to lowercase before upsert', async () => {
      contactUpsert.mockResolvedValue({});

      await service.importCsv('aud-1', csv('USER@Example.COM'));

      expect(contactUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { audienceId_email: { audienceId: 'aud-1', email: 'user@example.com' } },
          create: { email: 'user@example.com', audienceId: 'aud-1' },
        }),
      );
    });

    it('counts rows with missing email as errors', async () => {
      // CSV has name column but no email column
      const buf = csvWithHeader('name', 'Alice', 'Bob');
      const result = await service.importCsv('aud-1', buf);

      expect(result.errors).toBe(2);
      expect(result.imported).toBe(0);
      expect(contactUpsert).not.toHaveBeenCalled();
    });

    it('counts rows with whitespace-only email as errors', async () => {
      // csv-parse trims whitespace; rows with a blank email field are errors.
      const buf = Buffer.from('email\nvalid@example.com\n   \n   \n');
      const result = await service.importCsv('aud-1', buf);

      expect(result.errors).toBe(2); // two whitespace-only rows
      expect(result.imported).toBe(1);
    });

    it('counts rows with invalid email format as errors', async () => {
      const buf = csv('notanemail');
      const result = await service.importCsv('aud-1', buf);

      expect(result.errors).toBe(1);
      expect(result.imported).toBe(0);
    });

    it('throws BadRequestException when audience does not exist', async () => {
      audienceFindUnique.mockResolvedValue(null);

      await expect(service.importCsv('aud-missing', csv('a@b.com'))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('handles P2002 unique violation from upsert as a skip', async () => {
      const p2002 = Object.assign(new Error('Unique violation'), { code: 'P2002' });
      contactUpsert.mockRejectedValue(p2002);

      const result = await service.importCsv('aud-1', csv('dup@example.com'));

      expect(result.skipped).toBe(1);
      expect(result.imported).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('handles an empty CSV (header only) gracefully', async () => {
      const buf = Buffer.from('email\n');
      const result = await service.importCsv('aud-1', buf);

      expect(result.imported).toBe(0);
      expect(result.errors).toBe(0);
      expect(contactUpsert).not.toHaveBeenCalled();
    });
  });

  // ── suppress / unsuppress / isSuppressed ─────────────────────────────────────

  describe('suppress', () => {
    it('upserts a lowercase-normalised suppression row', async () => {
      suppressionUpsert.mockResolvedValue({});

      await service.suppress('ws-1', 'USER@Example.COM');

      expect(suppressionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId_email: { workspaceId: 'ws-1', email: 'user@example.com' } },
          create: { workspaceId: 'ws-1', email: 'user@example.com' },
        }),
      );
    });

    it('is idempotent — second call does not throw', async () => {
      suppressionUpsert.mockResolvedValue({});
      await expect(service.suppress('ws-1', 'a@b.com')).resolves.not.toThrow();
      await expect(service.suppress('ws-1', 'a@b.com')).resolves.not.toThrow();
    });
  });

  describe('unsuppress', () => {
    it('deletes the suppression row', async () => {
      suppressionDelete.mockResolvedValue({});
      await service.unsuppress('ws-1', 'a@b.com');
      expect(suppressionDelete).toHaveBeenCalled();
    });

    it('is idempotent — P2025 (not found) does not throw', async () => {
      suppressionDelete.mockRejectedValue(Object.assign(new Error('Not found'), { code: 'P2025' }));
      await expect(service.unsuppress('ws-1', 'a@b.com')).resolves.not.toThrow();
    });
  });

  describe('isSuppressed', () => {
    it('returns true when suppression row exists', async () => {
      suppressionFindUnique.mockResolvedValue({ id: 'sup-1' });
      expect(await service.isSuppressed('ws-1', 'a@b.com')).toBe(true);
    });

    it('returns false when no suppression row', async () => {
      suppressionFindUnique.mockResolvedValue(null);
      expect(await service.isSuppressed('ws-1', 'a@b.com')).toBe(false);
    });
  });
});
