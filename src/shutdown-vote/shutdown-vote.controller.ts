import { BadRequestException, Body, Controller, Get, OnModuleInit, Post, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { DbService } from '../database/db.service';

class VoteDto {
  @IsIn(['close', 'keep']) vote!: 'close' | 'keep';
}

/** Voting closes at the end of July 19, 2026 (Thai time). */
const VOTE_DEADLINE = new Date('2026-07-20T00:00:00+07:00').getTime();

/** If this many players vote 'keep', the server stays open; otherwise it closes as scheduled. */
const KEEP_GOAL = 50;

/**
 * Shutdown poll: should the server really close on July 20? One vote per linked
 * Steam account, re-voting overwrites.
 */
// ponytail: temporary poll — delete together with the web shutdown card after 2026-07-20
@Controller('shutdown-vote')
export class ShutdownVoteController implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly users: UsersService,
  ) {}

  private tbl() { return this.db.table('sv', 'shutdown_vote'); }

  async onModuleInit() {
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS ${this.tbl()} (
        steam_id CHAR(17) NOT NULL,
        vote ENUM('close','keep') NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (steam_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
  }

  /** Public tallies — the notice card also shows on the (unauthenticated) login page. */
  @Get('results')
  async results() {
    const rows = await this.db.query<{ vote: 'close' | 'keep'; c: number }>(
      `SELECT vote, COUNT(*) AS c FROM ${this.tbl()} GROUP BY vote`,
    );
    const out = { close: 0, keep: 0, goal: KEEP_GOAL };
    for (const r of rows) out[r.vote] = Number(r.c);
    return out;
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: JwtPayload) {
    const row = await this.db.first<{ vote: string }>(
      `SELECT vote FROM ${this.tbl()} WHERE steam_id = ?`,
      [await this.steamOf(user)],
    );
    return { vote: row?.vote ?? null };
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async vote(@CurrentUser() user: JwtPayload, @Body() body: VoteDto) {
    if (Date.now() >= VOTE_DEADLINE) throw new BadRequestException('ปิดรับโหวตแล้ว');
    const steam = await this.steamOf(user);
    // Only players who have actually joined the game may vote (PlayerStats row = has played).
    const played = await this.db.first(
      `SELECT 1 FROM ${this.db.tableRaw('PlayerStats')} WHERE SteamId = ?`,
      [steam],
    );
    if (!played) throw new BadRequestException('ไม่พบชื่อผู้เล่นในเกม — ต้องเคยเข้าเล่นในเซิร์ฟเวอร์ก่อนจึงจะโหวตได้');
    if (await this.db.first(`SELECT 1 FROM ${this.tbl()} WHERE steam_id = ?`, [steam])) {
      throw new BadRequestException('คุณโหวตไปแล้ว — โหวตได้ครั้งเดียว');
    }
    await this.db.query(
      `INSERT INTO ${this.tbl()} (steam_id, vote) VALUES (?, ?)`,
      [steam, body.vote],
    );
    await this.grantVoteVip(steam);
    return { ok: true, vote: body.vote };
  }

  /** Silent 7-day VIP thank-you (deliberately NOT announced anywhere). Never fails the vote. */
  private async grantVoteVip(steam: string) {
    try {
      const grants = this.db.table('sv', 'vip_grants');
      const pkg = await this.db.first<{ group_id: string }>(
        `SELECT group_id FROM ${this.db.table('sv', 'vip_packages')}
         WHERE enabled = 1 ORDER BY sort ASC, price_coins ASC LIMIT 1`,
      );
      if (!pkg) return;
      // Same extend-or-create upsert as VipService.grantAndLog, fixed at 7 days.
      await this.db.query(
        `INSERT INTO ${grants} (steam_id, group_id, expires_at, active)
         VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY), 1)
         ON DUPLICATE KEY UPDATE
           expires_at = DATE_ADD(GREATEST(UTC_TIMESTAMP(),
             CASE WHEN active = 1 THEN expires_at ELSE UTC_TIMESTAMP() END), INTERVAL 7 DAY),
           active = 1`,
        [steam, pkg.group_id],
      );
      await this.db.query(
        `INSERT INTO ${this.db.table('sv', 'vip_log')} (steam_id, group_id, action, days, actor)
         VALUES (?, ?, 'vote', 7, 'web')`,
        [steam, pkg.group_id],
      );
    } catch {
      // vote already recorded — a failed VIP grant must not surface to the player
    }
  }

  private async steamOf(user: JwtPayload): Promise<string> {
    const steam = user.steam_id ?? (await this.users.findSteamByDiscord(user.sub));
    if (!steam) throw new BadRequestException('ยังไม่ได้เชื่อมบัญชี — ผูก Discord ↔ Steam ก่อน');
    return steam;
  }
}
