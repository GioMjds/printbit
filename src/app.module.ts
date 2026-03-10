import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import {
  AdminModule,
  CopyModule,
  EventsModule,
  FinancialModule,
  PagesModule,
  ScanModule,
  SystemModule,
  WirelessSessionModule,
} from '@/modules';
import { PrismaModule } from '@/infrastructure/persistence/prisma';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ServeStaticModule.forRoot(
      {
        rootPath: join(process.cwd(), 'src', 'fonts'),
        serveRoot: '/fonts',
        serveStaticOptions: {
          maxAge: 31536000000,
          immutable: true,
        },
      },
      {
        rootPath: join(process.cwd(), 'node_modules', 'pdfjs-dist', 'build'),
        serveRoot: '/libs/pdfjs',
        serveStaticOptions: {
          maxAge: 604800000,
        },
      },
      {
        rootPath: join(process.cwd(), 'src', 'public'),
        exclude: ['/api/{*path}'],
      },
      {
        rootPath: join(process.cwd(), 'dist', 'public'),
        exclude: ['/api/{*path}'],
      },
    ),
    CqrsModule.forRoot(),
    PrismaModule,
    EventsModule,
    PagesModule,
    FinancialModule,
    ScanModule,
    CopyModule,
    WirelessSessionModule,
    AdminModule,
    SystemModule,
  ],
})
export class AppModule {}
