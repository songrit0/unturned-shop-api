import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

/** ไฟล์ฝากชั่วคราว: อัปโหลด (ต้องมี JWT) แล้วได้ URL สาธารณะเปิดดูได้ 24 ชม. จากนั้นถูกลบ */
const DIR = path.join(process.cwd(), 'tmp-files');
const TTL_MS = 24 * 60 * 60 * 1000;

// ไม่มี @types/multer ในโปรเจกต์ — ประกาศเท่าที่ใช้พอ
interface UploadedFileLike {
  originalname: string;
  buffer: Buffer;
  size: number;
}

@Controller('files')
export class FilesController {
  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async upload(@UploadedFile() file: UploadedFileLike | undefined, @Req() req: Request) {
    if (!file) throw new BadRequestException('ต้องแนบไฟล์ใน form field ชื่อ "file"');
    const ext = (path.extname(file.originalname).slice(1) || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const id = `${randomUUID()}.${ext}`;
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(path.join(DIR, id), file.buffer);
    this.sweep(); // ponytail: กวาดไฟล์หมดอายุตอนมีอัปโหลดใหม่ พอสำหรับงานนี้ ไม่ต้องตั้ง cron
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    return {
      id,
      url: `${proto}://${req.get('host')}/files/${id}`,
      expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    };
  }

  @Get(':id')
  async view(@Param('id') id: string, @Res() res: Response) {
    // id เป็น uuid.ext เท่านั้น — กัน path traversal
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i.test(id)) throw new NotFoundException();
    const file = path.join(DIR, id);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) throw new NotFoundException();
    if (Date.now() - stat.mtimeMs > TTL_MS) {
      await fs.unlink(file).catch(() => undefined);
      throw new NotFoundException();
    }
    res.sendFile(file); // content-type ตามนามสกุลไฟล์ → pdf/รูป เปิดดูในเบราว์เซอร์ได้เลย
  }

  private sweep(): void {
    void fs
      .readdir(DIR)
      .then((names) =>
        Promise.all(
          names.map(async (n) => {
            const p = path.join(DIR, n);
            const s = await fs.stat(p).catch(() => null);
            if (s && Date.now() - s.mtimeMs > TTL_MS) await fs.unlink(p).catch(() => undefined);
          }),
        ),
      )
      .catch(() => undefined);
  }
}
