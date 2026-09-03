import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /templates — list all templates (id, name, subject only — no html body) */
  @Get()
  listTemplates() {
    return this.prisma.template.findMany({
      select: { id: true, name: true, subject: true },
      orderBy: { createdAt: 'desc' },
    });
  }


  /** POST /templates — create a new template */
  @Post()
  @HttpCode(201)
  createTemplate(@Body() body: { name: string; subject?: string; html: string }) {
    return this.prisma.template.create({ data: body });
  }

  /** GET /templates/:id — get single template including full html */
  @Get(':id')
  async getTemplate(@Param('id') id: string) {
    const template = await this.prisma.template.findUnique({ where: { id } });
    if (!template) throw new NotFoundException(`Template ${id} not found`);
    return template;
  }

  /** PATCH /templates/:id — partial update any field(s) */
  @Patch(':id')
  async updateTemplate(
    @Param('id') id: string,
    @Body() body: { name?: string; subject?: string; html?: string },
  ) {
    const template = await this.prisma.template.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!template) throw new NotFoundException(`Template ${id} not found`);
    return this.prisma.template.update({ where: { id }, data: body });
  }

  /** DELETE /templates/:id — delete a template (only if not referenced by any campaign) */
  @Delete(':id')
  @HttpCode(200)
  async deleteTemplate(@Param('id') id: string) {
    const template = await this.prisma.template.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!template) throw new NotFoundException(`Template ${id} not found`);
    await this.prisma.template.delete({ where: { id } });
    return { id, deleted: true };
  }
}
