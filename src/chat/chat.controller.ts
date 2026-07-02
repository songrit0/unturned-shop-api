import { Body, Controller, InternalServerErrorException, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { execFile } from 'child_process';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

class ChatDto {
  @IsString() message!: string;
  /** system prompt กำหนดบทบาท/รูปแบบคำตอบ (ไม่บังคับ) */
  @IsOptional() @IsString() system?: string;
  /** session_id จาก response ก่อนหน้า เพื่อคุยต่อเนื่อง (ไม่บังคับ) */
  @IsOptional() @IsUUID() session?: string;
}

/**
 * ตอบแชทด้วย claude CLI (headless mode) — ต้องมี claude ติดตั้งและ login แล้วบนเครื่องที่รัน
 * ponytail: spawn claude ทีละ request พอสำหรับ traffic ต่ำ — ถ้าใช้หนักค่อยย้ายไป Agent SDK
 */
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  @Post()
  chat(@Body() dto: ChatDto): Promise<{ reply: string; session: string }> {
    // --setting-sources ว่าง = ไม่โหลด settings/plugins ของเครื่อง กันข้อความแปลกปลอมปนในคำตอบ
    const args = ['-p', '--output-format', 'json', '--setting-sources', ''];
    if (dto.system) args.push('--system-prompt', dto.system);
    if (dto.session) args.push('--resume', dto.session);
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.env.CLAUDE_BIN || 'claude',
        args,
        { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(new InternalServerErrorException(String(err.message).slice(0, 500)));
          const out = JSON.parse(stdout);
          resolve({ reply: out.result, session: out.session_id });
        },
      );
      // ส่งข้อความทาง stdin กันปัญหา quote/ขึ้นบรรทัดใหม่/shell injection
      child.stdin!.end(dto.message, 'utf8');
    });
  }
}
