// Jest manual mock for PrismaService.
// This file lives at src/__mocks__/prisma/prisma.service.ts and is used
// automatically whenever jest.mock('../prisma/prisma.service') is called.
// It prevents Jest from ever loading the ESM-only Prisma generated client.

export const PrismaService = jest.fn().mockImplementation(() => ({
  message: {
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
    delete:     jest.fn(),
    findMany:   jest.fn(),
  },
  event: {
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
    delete:     jest.fn(),
    findMany:   jest.fn(),
  },
  onModuleInit:    jest.fn().mockResolvedValue(undefined),
  onModuleDestroy: jest.fn().mockResolvedValue(undefined),
}));
