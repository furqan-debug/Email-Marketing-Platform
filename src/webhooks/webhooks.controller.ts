import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import type { SnsEnvelope } from './sns.types';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly webhooksService: WebhooksService) {}

  /**
   * POST /webhooks/ses-events
   *
   * Accepts raw SNS notifications forwarded from AWS.
   * SNS sends the body as JSON with Content-Type: text/plain or
   * application/json depending on the message type, so we accept both.
   */
  @Post('ses-events')
  @HttpCode(200)
  async handleSesEvents(
    @Headers('x-amz-sns-message-type') messageType: string | undefined,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    // SNS sends JSON bodies; NestJS parses them automatically.
    // Guard against non-object bodies.
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Expected JSON body');
    }

    const envelope = body as SnsEnvelope;
    this.logger.log(`SNS message received: type=${envelope.Type ?? messageType}`);

    return this.webhooksService.handleSnsEnvelope(envelope);
  }

  /**
   * POST /webhooks/inbound-reply
   *
   * Receives parsed inbound email payloads from email routing services,
   * SES Inbound S3/SNS, Cloudflare Email Routing, Postmark, SendGrid, or Zapier.
   */
  @Post('inbound-reply')
  @HttpCode(200)
  async handleInboundReply(
    @Body()
    body: {
      from: string;
      to?: string;
      subject?: string;
      inReplyTo?: string;
      references?: string;
      campaignId?: string;
      body?: string;
      text?: string;
      html?: string;
    },
  ) {
    if (!body || !body.from) {
      throw new BadRequestException('Field "from" is required');
    }
    return this.webhooksService.handleInboundReply(body);
  }
}

