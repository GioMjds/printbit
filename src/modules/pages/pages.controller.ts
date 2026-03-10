import { Controller, Get, Res, Param, HttpCode } from '@nestjs/common';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Response } from 'express';

const PUBLIC_DIR = join(process.cwd(), 'src', 'public');
const UPLOAD_HTML_PATH = join(PUBLIC_DIR, 'upload', 'index.html');

@Controller()
export class PagesController {
  @Get('favicon.ico')
  @HttpCode(204)
  favicon(): void {
    return;
  }

  @Get('admin')
  adminRedirect(@Res() res: Response): void {
    res.redirect('/admin/dashboard');
  }

  @Get()
  home(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  }

  @Get('print')
  print(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'print', 'index.html'));
  }

  @Get('copy')
  copy(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'copy', 'index.html'));
  }

  @Get('config')
  config(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'config', 'index.html'));
  }

  @Get('confirm')
  confirm(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'confirm', 'index.html'));
  }

  @Get('scan')
  scan(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'scan', 'index.html'));
  }

  @Get('upload')
  upload(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'upload', 'index.html'));
  }

  @Get('upload/:token')
  uploadWithToken(@Param('token') token: string, @Res() res: Response): void {
    const template = readFileSync(UPLOAD_HTML_PATH, 'utf-8');
    const safeToken = token.replace(/"/g, '&quot;');
    const rendered = template.replace('{{token}}', safeToken);
    res.type('html').send(rendered);
  }

  @Get('admin/dashboard')
  adminDashboard(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'admin', 'dashboard', 'index.html'));
  }

  @Get('admin/earnings')
  adminEarnings(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'admin', 'earnings', 'index.html'));
  }

  @Get('admin/coins')
  adminCoins(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'admin', 'coin-stats', 'index.html'));
  }

  @Get('admin/system')
  adminSystem(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'admin', 'system', 'index.html'));
  }

  @Get('admin/settings')
  adminSettings(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'admin', 'settings', 'index.html'));
  }

  @Get('admin/logs')
  adminLogs(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'admin', 'logs', 'index.html'));
  }
}
