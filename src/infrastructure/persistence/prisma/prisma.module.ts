import { Global, Module } from "@nestjs/common";
import { PrismaRepositoryProviders } from './repositories';
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  providers: [PrismaService, ...PrismaRepositoryProviders],
  exports: [PrismaService, ...PrismaRepositoryProviders],
})
export class PrismaModule {}