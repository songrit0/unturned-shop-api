import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { BmcService, BmcWebhookPayload } from './bmc.service';
import { TopupService } from './topup.service';

/**
 * Public BuyMeACoffee webhook receiver — no JWT (BMC calls this server-to-server). Authenticity
 * is established by the HMAC signature instead (see BmcService.verifySignature).
 *
 * Donor attribution: since BMC has no "create payment intent from our site" flow, donors are
 * asked (on the donate page) to put their steamID64 in the supporter message. We pull that out
 * of the webhook payload; a donation with no parseable steamID64 cannot be credited (the
 * `topups.steam_id` column is NOT NULL) and is logged for manual reconciliation only.
 */
@Controller('topup/webhook')
export class BmcWebhookController {
  private readonly log = new Logger(BmcWebhookController.name);

  constructor(
    private readonly bmc: BmcService,
    private readonly topup: TopupService,
  ) {}

  @Post('buymeacoffee')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature-sha256') signature: string | undefined,
  ) {
    this.log.log(`BMC webhook received: sigHeader=${signature ? 'present' : 'missing'} bodyLen=${req.rawBody?.length ?? 0}`);
    if (!this.bmc.verifySignature(req.rawBody, signature)) {
      this.log.warn('BMC webhook signature verification failed');
      throw new BadRequestException('invalid_signature');
    }

    const payload = req.body as BmcWebhookPayload;

    // We only credit one-time "Buy a coffee" / extra-purchase donations, not membership
    // lifecycle events (started/cancelled/etc.) — those need different handling and aren't
    // requested yet.
    if (payload.type !== 'donation.created' && payload.type !== 'extra_purchase.created') {
      this.log.log(`BMC webhook ignored (type=${payload.type ?? 'unknown'})`);
      return { ok: true, handled: false, reason: 'ignored_event_type' };
    }

    const ref = this.bmc.eventRef(payload);
    if (!ref) {
      this.log.warn('BMC webhook missing data.id — cannot dedupe, ignoring');
      return { ok: true, handled: false, reason: 'missing_event_id' };
    }

    const amountUsd = this.bmc.extractAmountUsd(payload);
    if (amountUsd === null) {
      this.log.warn(`BMC webhook ${ref}: could not extract a donation amount — ignoring`);
      return { ok: true, handled: false, reason: 'missing_amount' };
    }

    const steamId = this.bmc.extractSteamId(payload);
    if (!steamId) {
      // Real money was received but we can't tell whose account to credit. Log loudly so an
      // admin can reconcile manually from the BMC dashboard; do not throw (BMC would retry).
      this.log.warn(
        `BMC webhook ${ref}: no steamID64 found in supporter message — $${amountUsd} unattributed`,
      );
      return { ok: true, handled: false, reason: 'no_steam_id_in_message' };
    }

    const baht = Math.round(amountUsd * this.bmc.usdToThb());
    const result = await this.topup.creditBuyMeACoffee(ref, steamId, baht);
    return { ok: true, ...result };
  }
}
