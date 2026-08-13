/**
 * jest.setup.ts
 *
 * Loaded via Jest's `setupFiles` option before any test suite runs.
 * Populates process.env from the project-root .env file so tests can
 * read environment variables without needing them passed on the command line.
 *
 * dotenv.config() is a no-op if a variable is already set in the shell,
 * so values provided by CI (e.g. real secrets) always take precedence.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
