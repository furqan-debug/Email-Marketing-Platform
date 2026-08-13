import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // Disable the default body parser so we can configure it manually.
  // SNS sends Content-Type: text/plain but the body is valid JSON,
  // so we tell the JSON parser to accept both content types.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bodyParser = require('body-parser');
  app.use(bodyParser.json({ type: ['application/json', 'text/plain'] }));

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
