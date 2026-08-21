import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TemplateService } from './template.service';
import { TemplatesController } from './templates.controller';

@Module({
  imports: [PrismaModule],
  providers: [TemplateService],
  controllers: [TemplatesController],
  exports: [TemplateService],
})
export class TemplatesModule {}
