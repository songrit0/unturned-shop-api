import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/** Fields we rely on out of a BuyMeACoffee webhook event payload. Donors are asked to put their
 * steamID64 in the supporter message, which we extract from `support_note` (one-time "Buy a
 * coffee") or `note` (membership), whichever is present. BMC's payload otherwise has many more
 * fields we don't use. */
export interface BmcWebhookPayload {
  type?: string;
  data?: {
    id?: number | string;
    amount?: string | number;
    support_coffees?: string | number;
    support_coffee_price?: string | number;
    support_note?: string | null;
    note?: string | null;
    [key: string]: unknown;
  };
}

/** A steamID64 is always a 17-digit number (starts with 7656119...). Matches it anywhere in a
 * free-text supporter message so the donor can write e.g. "steam: 76561198012345678 thanks!". */
const STEAM_ID_RE = /\b7656\d{13}\b/;

@Injectable()
export class BmcService {
  private readonly log = new Logger(BmcService.name);

  constructor(private readonly cfg: ConfigService) {}

  private secret(): string {
    return this.cfg.get<string>('bmc.webhookSecret') || '';
  }

  usdToThb(): number {
    const v = Number(this.cfg.get<number>('bmc.usdToThb') ?? 36);
    return Number.isFinite(v) && v > 0 ? v : 36;
  }

  /**
   * Verifies the `X-Signature-Sha256` header: hex HMAC-SHA256 of the raw request body, keyed by
   * the webhook secret configured on the BMC dashboard. Returns false (closed) if no secret is
   * configured yet, or the header/body is missing/malformed — never throws.
   */
  verifySignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
    const secret = this.secret();
    if (!secret) {
      this.log.warn('BMC webhook received but BMC_WEBHOOK_SECRET is not configured — rejecting');
      return false;
    }
    if (!rawBody || !signatureHeader) return false;

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    // TEMP DEBUG (remove once verification is confirmed working): never logs the secret itself,
    // only the computed vs received signature strings, to diagnose a format/prefix mismatch.
    this.log.debug(`BMC sig debug: header="${signatureHeader}" expected="${expected}"`);
    const expectedBuf = Buffer.from(expected, 'hex');
    const givenBuf = Buffer.from(signatureHeader, 'hex');
    if (expectedBuf.length !== givenBuf.length) return false;
    try {
      return timingSafeEqual(expectedBuf, givenBuf);
    } catch {
      return false;
    }
  }

  /** Extracts a steamID64 from the donor's supporter message, or null if none found. */
  extractSteamId(payload: BmcWebhookPayload): string | null {
    const text = payload.data?.support_note ?? payload.data?.note ?? '';
    if (typeof text !== 'string') return null;
    const m = text.match(STEAM_ID_RE);
    return m ? m[0] : null;
  }

  /** USD amount donated, from `data.amount` (preferred) or coffees*price as a fallback. */
  extractAmountUsd(payload: BmcWebhookPayload): number | null {
    const d = payload.data;
    if (!d) return null;
    if (d.amount !== undefined && d.amount !== null) {
      const v = Number(d.amount);
      if (Number.isFinite(v) && v > 0) return v;
    }
    const coffees = Number(d.support_coffees);
    const price = Number(d.support_coffee_price);
    if (Number.isFinite(coffees) && Number.isFinite(price) && coffees > 0 && price > 0) {
      return coffees * price;
    }
    return null;
  }

  /** A stable per-event id used as the topups.ref idempotency key. */
  eventRef(payload: BmcWebhookPayload): string | null {
    const id = payload.data?.id;
    if (id === undefined || id === null || id === '') return null;
    return `bmc_${id}`;
  }
}
