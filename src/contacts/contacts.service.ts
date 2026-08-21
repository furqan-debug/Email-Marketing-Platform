import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: number;
  errorDetails: string[];
}

export interface ColumnMapping {
  email?: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, string>;
}

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // CSV Import
  // ---------------------------------------------------------------------------

  /**
   * Import contacts from a CSV buffer into the specified audience.
   * Supports custom column mapping from the web UI, or automatically auto-detects
   * columns and saves any extra columns into the contact's custom JSON attributes.
   */
  async importCsv(
    audienceId: string,
    fileBuffer: Buffer,
    mapping?: ColumnMapping,
  ): Promise<ImportResult> {
    // Validate audience exists
    const audience = await this.prisma.audience.findUnique({
      where: { id: audienceId },
      select: { id: true },
    });
    if (!audience) {
      throw new BadRequestException(`Audience ${audienceId} not found`);
    }

    const rows = await this.parseCsv(fileBuffer);
    if (rows.length === 0) {
      return { imported: 0, skipped: 0, errors: 0, errorDetails: [] };
    }

    // Helper to find a value in a row by possible header names
    const findField = (row: Record<string, string>, explicitKey?: string, fallbackGuesses: string[] = []): string | undefined => {
      if (explicitKey && row[explicitKey] !== undefined) {
        return row[explicitKey];
      }
      for (const guess of fallbackGuesses) {
        // Exact match
        if (row[guess] !== undefined) return row[guess];
        // Case-insensitive match
        const foundKey = Object.keys(row).find(k => k.trim().toLowerCase() === guess.toLowerCase());
        if (foundKey && row[foundKey] !== undefined) return row[foundKey];
      }
      return undefined;
    };

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2; // 1-indexed + header row
      const raw = rows[i];

      // Resolve email using mapping or common aliases
      const rawEmail = findField(raw, mapping?.email, ['email', 'Email', 'EMAIL', 'e-mail', 'E-mail', 'mail', 'Mail', 'Contact Email']);
      if (!rawEmail || typeof rawEmail !== 'string' || !rawEmail.trim()) {
        errors++;
        errorDetails.push(`Row ${rowNum}: missing or empty email`);
        continue;
      }

      const email = rawEmail.trim().toLowerCase();
      if (!email.includes('@')) {
        errors++;
        errorDetails.push(`Row ${rowNum}: invalid email "${email}"`);
        continue;
      }

      // Resolve first and last name
      const rawFirstName = findField(raw, mapping?.firstName, ['firstName', 'First Name', 'firstname', 'first_name', 'FName', 'First']);
      const rawLastName = findField(raw, mapping?.lastName, ['lastName', 'Last Name', 'lastname', 'last_name', 'LName', 'Last']);

      const firstName = rawFirstName?.trim() || null;
      const lastName = rawLastName?.trim() || null;

      // Extract custom attributes
      const customAttributes: Record<string, string> = {};

      if (mapping?.attributes && Object.keys(mapping.attributes).length > 0) {
        // User provided specific attribute tag mappings
        for (const [tag, colRaw] of Object.entries(mapping.attributes)) {
          const col = String(colRaw);
          if (raw[col] !== undefined && raw[col].trim() !== '') {
            customAttributes[tag] = raw[col].trim();
          }
        }
      } else {
        // Auto-capture any remaining column not used as email/firstName/lastName
        const standardHeaders = new Set([
          (mapping?.email || 'email').toLowerCase(),
          (mapping?.firstName || 'firstname').toLowerCase(),
          'first name', 'first_name',
          (mapping?.lastName || 'lastname').toLowerCase(),
          'last name', 'last_name',
        ]);

        for (const [header, val] of Object.entries(raw)) {
          const cleanHeader = header.trim();
          const normalized = cleanHeader.toLowerCase().replace(/[^a-z0-9_]/g, '_');
          if (!standardHeaders.has(cleanHeader.toLowerCase()) && !standardHeaders.has(normalized) && val && val.trim() !== '') {
            customAttributes[normalized] = val.trim();
            // Also store original clean header name as key
            if (normalized !== cleanHeader) {
              customAttributes[cleanHeader] = val.trim();
            }
          }
        }
      }

      try {
        await this.prisma.contact.upsert({
          where: {
            audienceId_email: { audienceId, email },
          },
          create: {
            email,
            firstName,
            lastName,
            attributes: Object.keys(customAttributes).length > 0 ? customAttributes : undefined,
            audienceId,
          },
          update: {
            firstName: firstName || undefined,
            lastName: lastName || undefined,
            attributes: Object.keys(customAttributes).length > 0 ? customAttributes : undefined,
          },
        });

        imported++;
      } catch (err: any) {
        if (err?.code === 'P2002') {
          skipped++;
        } else {
          errors++;
          errorDetails.push(`Row ${rowNum}: ${err?.message ?? 'unknown error'}`);
        }
      }
    }

    this.logger.log(
      `CSV import for audience ${audienceId}: imported=${imported} skipped=${skipped} errors=${errors}`,
    );

    return { imported, skipped, errors, errorDetails };
  }

  // ---------------------------------------------------------------------------
  // Suppression
  // ---------------------------------------------------------------------------

  /**
   * Add an email to the workspace suppression list.
   * Idempotent — calling twice has no effect.
   */
  async suppress(workspaceId: string, email: string): Promise<void> {
    const normalised = email.trim().toLowerCase();
    await this.prisma.suppression.upsert({
      where: { workspaceId_email: { workspaceId, email: normalised } },
      create: { workspaceId, email: normalised },
      update: {},
    });
    this.logger.log(`Suppressed ${normalised} in workspace ${workspaceId}`);
  }

  /**
   * Remove an email from the workspace suppression list.
   * Idempotent — safe to call even if not suppressed.
   */
  async unsuppress(workspaceId: string, email: string): Promise<void> {
    const normalised = email.trim().toLowerCase();
    try {
      await this.prisma.suppression.delete({
        where: { workspaceId_email: { workspaceId, email: normalised } },
      });
      this.logger.log(`Unsuppressed ${normalised} in workspace ${workspaceId}`);
    } catch (err: any) {
      // P2025 = record not found — fine, already not suppressed
      if (err?.code !== 'P2025') throw err;
    }
  }

  /**
   * Check whether a specific email is suppressed for a workspace.
   */
  async isSuppressed(workspaceId: string, email: string): Promise<boolean> {
    const normalised = email.trim().toLowerCase();
    const row = await this.prisma.suppression.findUnique({
      where: { workspaceId_email: { workspaceId, email: normalised } },
      select: { id: true },
    });
    return row !== null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private parseCsv(buffer: Buffer): Promise<Record<string, string>[]> {
    return new Promise((resolve, reject) => {
      const records: Record<string, string>[] = [];
      const stream = Readable.from(buffer);

      stream
        .pipe(
          parse({
            columns: true,  // first row is header
            trim: true,
            bom: true,      // handle UTF-8 BOM from Excel exports
            // Note: skip_empty_lines is intentionally NOT set so that rows
            // with a blank email column reach the service and are counted
            // as errors rather than silently dropped.
          }),
        )
        .on('data', (row: Record<string, string>) => records.push(row))
        .on('error', reject)
        .on('end', () => resolve(records));
    });
  }
}
