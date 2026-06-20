import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { NgrokService } from './ngrok/ngrok.service';

async function bootstrap() {
  const log = new Logger('Bootstrap');
  // rawBody: true keeps the raw request buffer alongside the normal parsed JSON body, needed to
  // verify the BuyMeACoffee webhook's HMAC signature (which is computed over the raw bytes).
  const app = await NestFactory.create(AppModule, { cors: true, rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const cfg = app.get(ConfigService);
  const port = cfg.get<number>('port')!;
  await app.listen(port);
  log.log(`HTTP listening on http://localhost:${port}`);

  // start ngrok AFTER server is listening; it will also publish the URL to Firestore
  const ngrokSvc = app.get(NgrokService);
  await ngrokSvc.start(port);
}
bootstrap();
