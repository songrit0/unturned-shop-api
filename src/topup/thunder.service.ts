import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Subset of the Thunder /verify/bank success payload we rely on. */
export interface ThunderVerifyData {
  isDuplicate: boolean;
  matchedAccount: boolean;
  amountInSlip: number;
  isAmountMatched: boolean;
  rawSlip: {
    transRef: string;
    date?: string;
    amount?: { amount?: number };
    sender?: unknown;
    receiver?: {
      bank?: { short?: string };
      account?: { name?: { th?: string } };
    };
  };
}

export interface ThunderVerifyResult {
  success: boolean;
  data: ThunderVerifyData;
  message?: string;
}

/**
 * Thunder slip-verification gateway client (Bearer THUNDER_API_KEY). Unlike PlernPay there is no
 * poll/cron path: the buyer uploads a bank-transfer slip image and we verify it synchronously.
 * Uses Node 20 global fetch. Maps documented Thunder error codes to clear HTTP errors.
 */
@Injectable()
export class ThunderService {
  private readonly log = new Logger(ThunderService.name);

  constructor(private readonly cfg: ConfigService) {}

  private base(): string {
    return this.cfg.get<string>('thunder.baseUrl') || 'https://api.thunder.in.th/v2';
  }

  /**
   * Verify a base64-encoded slip image against our registered account, requiring the amount to
   * match `matchAmount` and rejecting duplicates. Returns the parsed success payload, or throws
   * an HttpException carrying a stable reason code.
   */
  async verifyBase64(base64: string, matchAmount: number, remark = ''): Promise<ThunderVerifyResult> {
    const apiKey = this.cfg.get<string>('thunder.apiKey') || '';
    if (!apiKey) throw new HttpException('thunder_unavailable', HttpStatus.SERVICE_UNAVAILABLE);

    let res: Response;
    try {
      res = await fetch(`${this.base()}/verify/bank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          base64,
          matchAccount: true,
          matchAmount,
          checkDuplicate: true,
          remark,
        }),
      });
    } catch (e: any) {
      this.log.error(`Thunder verify network error: ${e.message}`);
      throw new HttpException('thunder_unreachable', HttpStatus.BAD_GATEWAY);
    }

    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }

    if (!res.ok) {
      // Thunder encodes the failure cause in `code` (or `message`); map to a clear client error.
      const code: string = (json?.code || json?.message || '').toString().toUpperCase();
      this.mapAndThrow(code, res.status, json ?? text?.slice(0, 300));
    }

    return json as ThunderVerifyResult;
  }

  /** Translate a Thunder error code into a clear HttpException. Never returns. */
  private mapAndThrow(code: string, httpStatus: number, detail: unknown): never {
    switch (code) {
      case 'SLIP_NOT_FOUND':
        throw new HttpException({ error: 'slip_not_found', message: 'Slip not found or unreadable.' }, HttpStatus.NOT_FOUND);
      case 'SLIP_PENDING':
        // 404-retry: the bank hasn't settled the slip yet — caller may retry shortly.
        throw new HttpException({ error: 'slip_pending', message: 'Slip is still pending at the bank; try again shortly.', retry: true }, HttpStatus.NOT_FOUND);
      case 'IMAGE_SIZE_TOO_LARGE':
        throw new HttpException({ error: 'image_too_large', message: 'Slip image is too large.' }, HttpStatus.BAD_REQUEST);
      case 'INVALID_IMAGE_FORMAT':
        throw new HttpException({ error: 'invalid_image_format', message: 'Unsupported slip image format.' }, HttpStatus.BAD_REQUEST);
      case 'QUOTA_EXCEEDED':
        throw new HttpException({ error: 'quota_exceeded', message: 'Slip-verification quota exceeded; contact an admin.' }, HttpStatus.FORBIDDEN);
      default:
        this.log.warn(`Thunder verify failed (${httpStatus}): ${JSON.stringify(detail).slice(0, 300)}`);
        throw new HttpException({ error: 'thunder_error', status: httpStatus, detail }, HttpStatus.BAD_GATEWAY);
    }
  }
}
