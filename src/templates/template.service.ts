import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ContactModel, TemplateModel } from '../../prisma/generated/client/models';

/**
 * Simple templating service – replaces `{{variable}}` placeholders in the
 * template HTML with values from a Contact record.
 *
 * Supported placeholders (case‑insensitive):
 *   {{first_name}}, {{last_name}}, {{email}}
 *   You can add more by extending the `variables` map below.
 */
@Injectable()
export class TemplateService {
  constructor(private readonly prisma: PrismaService) {}

  /** Load a template by its ID */
  async findById(id: string): Promise<TemplateModel> {
    return this.prisma.template.findUniqueOrThrow({ where: { id } });
  }

  /** Load a contact by its ID */
  async findContactById(id: string): Promise<ContactModel> {
    return this.prisma.contact.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Render a template for a given contact.
   * Returns the HTML string with all placeholders substituted.
   */
  render(template: TemplateModel, contact: ContactModel): string {
    const variables: Record<string, string | undefined> = {
      first_name: contact.firstName ?? undefined,
      last_name: contact.lastName ?? undefined,
      email: contact.email,
    };

    // Replace all {{var}} (case‑insensitive) with the corresponding value
    return template.html.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
      const val = variables[key.toLowerCase()];
      return val ?? '';
    });
  }
}
