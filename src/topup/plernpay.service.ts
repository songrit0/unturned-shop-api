import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type PlernpayStatus = 'pending' | 'confirmed' | 'expired' | 'cancelled';

export interface PlernpayCreateResult {
  ref: string;
  unique_amount: number;
  qr_code: string;
  promptpay_id: string;
  status: 'pending';
  expires_at: string;
  expires_in: number;
}

export interface PlernpayStatusResult {
  status: PlernpayStatus;
  [k: string]: unknown;
}

/**
 * Thin HTTP client for the PlernPay PromptPay top-up gateway (no webhook, no sandbox).
 * X-Client-Secret is server-only — never returned to clients. Uses Node 20 global fetch.
 */
@Injectable()
export class PlernpayService {
  private readonly log = new Logger(PlernpayService.name);

  constructor(private readonly cfg: ConfigService) {}

  private base(): string {
    return this.cfg.get<string>('plernpay.baseUrl') || 'https://api.plernpay.com';
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Client-ID': this.cfg.get<string>('plernpay.clientId') || '',
      'X-Client-Secret': this.cfg.get<string>('plernpay.clientSecret') || '',
    };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.base()}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e: any) {
      this.log.error(`PlernPay ${method} ${path} network error: ${e.message}`);
      throw new HttpException('plernpay_unreachable', HttpStatus.BAD_GATEWAY);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      this.log.warn(`PlernPay ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      throw new HttpException(
        { error: 'plernpay_error', status: res.status, detail: json ?? text?.slice(0, 300) },
        HttpStatus.BAD_GATEWAY,
      );
    }
    return json as T;
  }

  /** Create a PromptPay top-up. amount is THB (1..999999). */
  createTopup(amount: number, memo?: string): Promise<PlernpayCreateResult> {
    return this.call<PlernpayCreateResult>('POST', '/v1/topup/create', { amount, memo });
  }

  /** Poll the current status of a top-up by ref. */
  getTopup(ref: string): Promise<PlernpayStatusResult> {
    return this.call<PlernpayStatusResult>('GET', `/v1/topup/${encodeURIComponent(ref)}`);
  }

  /** Best-effort cancel; never throws into the caller's critical path. */
  async cancelTopup(ref: string): Promise<void> {
    try {
      await this.call<unknown>('POST', `/v1/topup/${encodeURIComponent(ref)}/cancel`);
    } catch (e: any) {
      this.log.warn(`PlernPay cancel ${ref} failed (best-effort): ${e.message}`);
    }
  }
}
