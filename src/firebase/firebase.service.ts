import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly log = new Logger(FirebaseService.name);
  private _firestore?: FirebaseFirestore.Firestore;
  private _enabled = false;

  constructor(private readonly cfg: ConfigService) {}

  onModuleInit() {
    const p = this.cfg.get<string>('firebase.serviceAccountPath')!;
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) {
      this.log.warn(`Firebase service account not found at ${abs} — Firebase features disabled`);
      return;
    }
    try {
      const sa = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(sa) });
      }
      this._firestore = admin.firestore();
      this._enabled = true;
      this.log.log(`Firebase initialized (project: ${sa.project_id})`);
    } catch (e: any) {
      this.log.error(`Firebase init failed: ${e.message}`);
    }
  }

  get enabled() { return this._enabled; }
  get firestore() { return this._firestore; }

  /** Writes the public API URL into a Firestore doc; frontend reads it on bootstrap. */
  async publishApiUrl(url: string) {
    if (!this._enabled || !this._firestore) {
      this.log.warn('Firebase not enabled — skipping publishApiUrl');
      return;
    }
    const docPath = this.cfg.get<string>('firebase.apiUrlDoc')!;
    const [coll, doc] = docPath.split('/');
    await this._firestore.collection(coll).doc(doc).set({
      url,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    this.log.log(`Published API URL to Firestore ${docPath}: ${url}`);
  }
}
