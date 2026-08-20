import {
  Controller,
  Post,
  Delete,
  Get,
  Query,
  Body,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
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
   * POST /contacts/import?audienceId=<uuid>
   * Accepts multipart/form-data with a CSV file under the field name "file".
   * Returns { imported, skipped, errors, errorDetails }.
   */
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importCsv(
    @Query('audienceId') audienceId: string,
    @UploadedFile() file: Express.Multer.File,
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

    this.logger.log(
      `CSV import request: audienceId=${audienceId} filename=${file.originalname} size=${file.size}`,
    );

    return this.contactsService.importCsv(audienceId, file.buffer);
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
}
