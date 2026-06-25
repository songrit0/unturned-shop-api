import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const log = new Logger('Bootstrap');
  // rawBody: true keeps the raw request buffer alongside the normal parsed JSON body, needed to
  // verify the BuyMeACoffee webhook's HMAC signature (which is computed over the raw bytes).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: true, rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Default express json limit (100kb) is too small for base64 screenshot uploads
  // (BMC manual-claim proof, Thunder slip images) — raise it, keeping rawBody capture enabled.
  app.useBodyParser('json', { limit: '15mb' });

  const cfg = app.get(ConfigService);
  const port = cfg.get<number>('port')!;
  await app.listen(port);
  log.log(`HTTP listening on http://localhost:${port}`);
}
bootstrap();
