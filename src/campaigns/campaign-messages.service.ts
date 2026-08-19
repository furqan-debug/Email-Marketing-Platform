import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface GenerateMessagesResult {
  created: number;
  suppressed: number;
}

@Injectable()
export class CampaignMessagesService {
  private readonly logger = new Logger(CampaignMessagesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate Message rows for every non-suppressed contact in the campaign's audience.
   *
   * Suppression is enforced HERE — at message-generation time, not at send time.
   * A suppressed contact never gets a Message row created; they are skipped silently.
   *
   * Algorithm:
   * 1. Load campaign + audience contacts (in one query).
   * 2. Collect all contact emails.
   * 3. Fetch the suppression list for the workspace in ONE bulk query (not N queries).
   * 4. Filter contacts: skip any whose email appears in the suppression set.
   * 5. Bulk-create Message rows for the remainder.
   *
   * Returns { created, suppressed } counts.
   */
  async generateMessages(campaignId: string): Promise<GenerateMessagesResult> {
    // Load campaign with its audience, workspace, and all audience contacts
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        audience: {
          include: {
            workspace: { select: { id: true } },
            contacts: { select: { id: true, email: true } },
          },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    const { audience } = campaign;
    const workspaceId = audience.workspace.id;
    const contacts = audience.contacts;

    if (contacts.length === 0) {
      this.logger.log(`Campaign ${campaignId}: no contacts in audience — nothing to generate`);
      return { created: 0, suppressed: 0 };
    }

    // Fetch the entire suppression list for this workspace in a single query.
    // Using a Set for O(1) email lookups when filtering contacts.
    const suppressionRows = await this.prisma.suppression.findMany({
      where: { workspaceId },
      select: { email: true },
    });
    const suppressedEmails = new Set(suppressionRows.map((r) => r.email.toLowerCase()));

    // Partition contacts into allowed vs suppressed
    const allowed: typeof contacts = [];
    let suppressed = 0;

    for (const contact of contacts) {
      if (suppressedEmails.has(contact.email.toLowerCase())) {
        suppressed++;
        this.logger.log(
          `Campaign ${campaignId}: skipping suppressed contact ${contact.email}`,
        );
      } else {
        allowed.push(contact);
      }
    }

    if (allowed.length === 0) {
      this.logger.log(
        `Campaign ${campaignId}: all ${contacts.length} contact(s) suppressed — no messages created`,
      );
      return { created: 0, suppressed };
    }

    // Bulk-create Message rows for non-suppressed contacts.
    // createMany skips rows that violate unique constraints (safe re-run).
    const result = await this.prisma.message.createMany({
      data: allowed.map((c) => ({
        campaignId,
        contactId: c.id,
      })),
      skipDuplicates: true,
    });

    this.logger.log(
      `Campaign ${campaignId}: created=${result.count} suppressed=${suppressed}`,
    );

    return { created: result.count, suppressed };
  }
}
