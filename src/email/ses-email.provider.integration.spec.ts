/**
 * Integration test for SesEmailProvider.
 *
 * This test requires live AWS credentials and a verified SES sender address.
 * It is SKIPPED by default and only runs when the following env vars are set:
 *
 *   RUN_SES_INTEGRATION_TESTS=true
 *   AWS_REGION=<your-region>
 *   AWS_SES_FROM_ADDRESS=<verified-sender@yourdomain.com>
 *   AWS_SES_TEST_RECIPIENT=<recipient@yourdomain.com>
 *
 * AWS credentials are picked up automatically from the environment
 * (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or an IAM role).
 *
 * Example:
 *   RUN_SES_INTEGRATION_TESTS=true \
 *   AWS_REGION=us-east-1 \
 *   AWS_SES_FROM_ADDRESS=noreply@example.com \
 *   AWS_SES_TEST_RECIPIENT=you@example.com \
 *   npx jest ses-email.provider.integration.spec.ts
 */

import { SesEmailProvider } from './ses-email.provider';

const RUN = process.env.RUN_SES_INTEGRATION_TESTS === 'true';

const describeOrSkip = RUN ? describe : describe.skip;

describeOrSkip('SesEmailProvider — live AWS integration', () => {
  let provider: SesEmailProvider;

  beforeAll(() => {
    provider = new SesEmailProvider();
  });

  it('should send one email and return a MessageId as providerId', async () => {
    const to = process.env.AWS_SES_TEST_RECIPIENT;
    if (!to) {
      throw new Error('Set AWS_SES_TEST_RECIPIENT env var to run this test');
    }

    const result = await provider.send({
      to,
      subject: 'Integration test — SES Email Provider',
      html: '<p>This is an automated integration test from the email marketing platform.</p>',
    });

    expect(result).toHaveProperty('providerId');
    expect(typeof result.providerId).toBe('string');
    expect(result.providerId.length).toBeGreaterThan(0);
    // SES MessageIds are not empty strings and do not equal our fallback value
    expect(result.providerId).not.toBe('ses-unknown');
  }, 15_000);
});
