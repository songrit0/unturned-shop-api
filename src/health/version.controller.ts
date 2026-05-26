import { Controller, Get } from '@nestjs/common';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface VersionInfo {
  name: string;
  version: string;
  commit: string | null;
  branch: string | null;
  builtAt: string;
  node: string;
  uptimeSeconds: number;
}

@Controller('version')
export class VersionController {
  private readonly cached: VersionInfo;

  constructor() {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    let pkg: any = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* ignore */ }

    this.cached = {
      name: pkg.name || 'unturned-shop-api',
      version: pkg.version || '0.0.0',
      commit: this.git('rev-parse --short HEAD'),
      branch: this.git('rev-parse --abbrev-ref HEAD'),
      builtAt: new Date().toISOString(),
      node: process.version,
      uptimeSeconds: 0,
    };
  }

  private git(args: string): string | null {
    try {
      return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'], cwd: path.resolve(__dirname, '..', '..') })
        .toString().trim() || null;
    } catch { return null; }
  }

  @Get()
  get(): VersionInfo {
    return { ...this.cached, uptimeSeconds: Math.floor(process.uptime()) };
  }
}
