import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ngrok from '@ngrok/ngrok';
import { FirebaseService } from '../firebase/firebase.service';

@Injectable()
export class NgrokService implements OnModuleDestroy {
  private readonly log = new Logger(NgrokService.name);
  private listener?: any;
  private _publicUrl?: string;

  constructor(
    private readonly cfg: ConfigService,
    private readonly firebase: FirebaseService,
  ) {}

  /** Called from main.ts after the HTTP server has been bound to PORT. */
  async start(port: number) {
    const token = this.cfg.get<string>('ngrok.authtoken');
    if (!token) {
      this.log.warn('NGROK_AUTHTOKEN not set — skipping tunnel (API will only be reachable via localhost)');
      return;
    }
    const domain = this.cfg.get<string>('ngrok.domain');
    try {
      const opts: any = { addr: port, authtoken: token };
      if (domain) opts.domain = domain;
      this.listener = await ngrok.forward(opts);
      this._publicUrl = this.listener.url();
      this.log.log(`ngrok tunnel: ${this._publicUrl} → http://localhost:${port}${domain ? ' (reserved)' : ''}`);
      if (this._publicUrl) {
        await this.firebase.publishApiUrl(this._publicUrl);
      }
    } catch (e: any) {
      this.log.error(`ngrok failed to start: ${e.message}`);
    }
  }

  get publicUrl() { return this._publicUrl; }

  async onModuleDestroy() {
    try { await this.listener?.close(); } catch { /* ignore */ }
  }
}
