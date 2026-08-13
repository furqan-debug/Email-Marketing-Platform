// Stub for the Prisma generated ESM client.
// Jest's moduleNameMapper points here so the generated client (which uses
// import.meta.url and cannot run in CJS/Jest) is never actually loaded.
// PrismaService itself is separately mocked via jest.mock() in each spec.

export const PrismaClient = jest.fn().mockImplementation(() => ({}));
