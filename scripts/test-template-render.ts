import { TemplateService } from '../src/templates/template.service';
import type { ContactModel, TemplateModel } from '../prisma/generated/client/models';

async function run() {
  console.log('🧪 Testing TemplateService.render()...\n');

  // Instantiate the service manually (prisma is not used during render)
  const templateService = new TemplateService(null as any);

  // Mock template
  const mockTemplate: TemplateModel = {
    id: 'tpl-123',
    name: 'Welcome Template',
    subject: 'Welcome, {{first_name}}!',
    html: `
      <div>
        <h1>Hello, {{first_name}} {{last_name}}!</h1>
        <p>Thank you for signing up with {{email}}.</p>
        <p>We are excited to have you, {{first_name}}.</p>
      </div>
    `.trim(),
  };

  // Mock contact
  const mockContact: ContactModel = {
    id: 'ct-456',
    email: 'ALICE@EXAMPLE.COM',
    firstName: 'Alice',
    lastName: 'Smith',
    audienceId: 'aud-789',
  };

  console.log('--- Input Contact ---');
  console.log(`Email: ${mockContact.email}`);
  console.log(`First Name: ${mockContact.firstName}`);
  console.log(`Last Name: ${mockContact.lastName}\n`);

  console.log('--- Input Template HTML ---');
  console.log(mockTemplate.html);
  console.log('');

  // Call render
  const renderedHtml = templateService.render(mockTemplate, mockContact);

  console.log('--- Rendered Output HTML ---');
  console.log(renderedHtml);
  console.log('');

  // Assertion check
  if (
    renderedHtml.includes('Hello, Alice Smith!') &&
    renderedHtml.includes('with ALICE@EXAMPLE.COM.') &&
    renderedHtml.includes('have you, Alice.')
  ) {
    console.log('✅ Success! Variable substitution works exactly as expected.');
  } else {
    console.error('❌ Render failure: placeholder mismatch.');
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
