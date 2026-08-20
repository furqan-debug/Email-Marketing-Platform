import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Catch, ArgumentsHost, HttpException, ExceptionFilter, Logger } from '@nestjs/common';

/** Logs every unhandled exception to stdout so it appears in Railway logs. */
@Catch()
class AllExceptionsLogger implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const message = exception instanceof HttpException
      ? exception.message
      : (exception instanceof Error ? exception.message : 'Internal server error');

    if (status >= 500) {
      this.logger.error(`${status} — ${message}`, exception instanceof Error ? exception.stack : undefined);
    }

    response.status(status).json({ statusCode: status, message });
  }
}

async function bootstrap() {
  // Disable the default body parser so we can configure it manually.
  // SNS sends Content-Type: text/plain but the body is valid JSON,
  // so we tell the JSON parser to accept both content types.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Enable CORS so the Vercel frontend can call this API
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Global exception filter — logs real errors to stdout (visible in Railway)
  app.useGlobalFilters(new AllExceptionsLogger());

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bodyParser = require('body-parser');
  app.use(bodyParser.json({ type: ['application/json', 'text/plain'] }));

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
