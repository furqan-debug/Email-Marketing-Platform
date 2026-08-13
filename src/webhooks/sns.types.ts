/**
 * Narrow SNS envelope types used by this webhook handler.
 * Only the fields we actually read are declared; extra fields are ignored.
 */

export type SnsMessageType =
  | 'SubscriptionConfirmation'
  | 'Notification'
  | 'UnsubscribeConfirmation';

export interface SnsEnvelope {
  Type: SnsMessageType;
  MessageId: string;
  TopicArn: string;
  /** Present on SubscriptionConfirmation */
  SubscribeURL?: string;
  /** Present on Notification */
  Message?: string;
  Timestamp: string;
  Subject?: string;
}

/**
 * SES event notification types we handle.
 * https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-examples.html
 */
export type SesEventType = 'Send' | 'Delivery' | 'Bounce' | 'Complaint' | 'Open' | 'Click';

export interface SesNotificationMessage {
  eventType: SesEventType;
  mail: {
    messageId: string;
    timestamp: string;
    [key: string]: unknown;
  };
  delivery?: Record<string, unknown>;
  bounce?: Record<string, unknown>;
  complaint?: Record<string, unknown>;
  open?: Record<string, unknown>;
  click?: Record<string, unknown>;
}
