import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  Query,
  Body,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ContactsService, ImportResult } from './contacts.service';
import { PrismaService } from '../prisma/prisma.service';

interface SuppressDto {
  workspaceId: string;
  email: string;
}

@Controller('contacts')
export class ContactsController {
  private readonly logger = new Logger(ContactsController.name);

  constructor(
    private readonly contactsService: ContactsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /contacts/audiences?workspaceId=<uuid>
   * Returns all audiences for a workspace (or all if no workspaceId given).
   * Kept for frontend backward compatibility — prefer GET /audiences.
   */
  @Get('audiences')
  listAudiences(@Query('workspaceId') workspaceId?: string) {
    return this.prisma.audience.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      select: { id: true, name: true, workspaceId: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * GET /contacts?audienceId=<uuid>&page=1&limit=50
   * Paginated list of contacts in an audience.
   */
  @Get()
  async listContacts(
    @Query('audienceId') audienceId: string,
    @Query('page') pageStr?: string,
    @Query('limit') limitStr?: string,
  ) {
    if (!audienceId) {
      throw new BadRequestException('audienceId query parameter is required');
    }
    const page  = Math.max(1, parseInt(pageStr  || '1',  10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(limitStr || '50', 10) || 50));
    const skip  = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.contact.findMany({
        where: { audienceId },
        select: { id: true, email: true, firstName: true, lastName: true, attributes: true },
        orderBy: { email: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.contact.count({ where: { audienceId } }),
    ]);

    return { data, total, page, limit, pages: Math.ceil(total / limit) };
  }

  /**
   * POST /contacts/import?audienceId=<uuid>
   * Accepts multipart/form-data with a CSV file under "file", and optional "mapping" field.
   * Returns { imported, skipped, errors, errorDetails }.
   */
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importCsv(
    @Query('audienceId') audienceId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('mapping') mappingRaw?: string,
    @Query('mapping') mappingQuery?: string,
  ): Promise<ImportResult> {
    if (!audienceId) {
      throw new BadRequestException('audienceId query parameter is required');
    }
    if (!file) {
      throw new BadRequestException('CSV file is required (field name: "file")');
    }
    if (!file.originalname?.toLowerCase().endsWith('.csv') && file.mimetype !== 'text/csv') {
      throw new BadRequestException('Uploaded file must be a CSV');
    }

    let mappingParsed: any = undefined;
    const mappingToParse = mappingRaw || mappingQuery;
    if (mappingToParse) {
      try {
        mappingParsed = typeof mappingToParse === 'string' ? JSON.parse(mappingToParse) : mappingToParse;
      } catch {
        this.logger.warn(`Could not parse CSV mapping JSON: ${mappingToParse}`);
      }
    }

    this.logger.log(
      `CSV import request: audienceId=${audienceId} filename=${file.originalname} size=${file.size}`,
    );

    return this.contactsService.importCsv(audienceId, file.buffer, mappingParsed);
  }

  /**
   * POST /contacts/suppress
   * Body: { workspaceId, email }
   * Adds the email to the workspace suppression list.
   */
  @Post('suppress')
  async suppress(@Body() body: SuppressDto): Promise<{ status: string }> {
    if (!body?.workspaceId || !body?.email) {
      throw new BadRequestException('workspaceId and email are required');
    }
    await this.contactsService.suppress(body.workspaceId, body.email);
    return { status: 'suppressed' };
  }

  /**
   * DELETE /contacts/suppress
   * Body: { workspaceId, email }
   * Removes the email from the workspace suppression list.
   */
  @Delete('suppress')
  async unsuppress(@Body() body: SuppressDto): Promise<{ status: string }> {
    if (!body?.workspaceId || !body?.email) {
      throw new BadRequestException('workspaceId and email are required');
    }
    await this.contactsService.unsuppress(body.workspaceId, body.email);
    return { status: 'unsuppressed' };
  }

  /**
   * GET /contacts/:id — get a single contact by id.
   * NOTE: must be defined AFTER all static-segment routes (audiences, import, suppress)
   * so NestJS does not match those names as :id values.
   */
  @Get(':id')
  async getContact(@Param('id') id: string) {
    const contact = await this.prisma.contact.findUnique({
      where: { id },
      include: { audience: { select: { id: true, name: true } } },
    });
    if (!contact) throw new NotFoundException(`Contact ${id} not found`);
    return contact;
  }

  /**
   * DELETE /contacts/:id — delete a contact (cascades Message rows via DB FK).
   */
  @Delete(':id')
  async deleteContact(@Param('id') id: string) {
    const contact = await this.prisma.contact.findUnique({
      where: { id },
      select: { id: true, email: true },
    });
    if (!contact) throw new NotFoundException(`Contact ${id} not found`);
    await this.prisma.contact.delete({ where: { id } });
    return { id, email: contact.email, deleted: true };
  }
}
