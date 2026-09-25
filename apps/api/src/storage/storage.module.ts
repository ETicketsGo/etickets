import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORE, type ObjectStore } from './object-store.interface';
import { ObjectStoreService } from './object-store.service';
import { PostgresObjectStore } from './postgres-object-store';
import { R2ObjectStore } from './r2-object-store';

/**
 * Which object store this deployment uses, decided once at boot.
 *
 * ── WHY THE DRIVER IS CHOSEN HERE AND NOT PER CALL ─────────────────────────────────
 * A caller that chose its own driver would be a caller that could choose differently from the
 * one beside it, and the bytes of a single poster would end up split between two stores. One
 * decision, made from configuration, injected everywhere.
 *
 * ── WHY GLOBAL ─────────────────────────────────────────────────────────────────────
 * Events, organizations and the backfill all need it, and they are in three different module
 * trees. The alternative is importing this module in each of them and remembering to import it
 * in the fourth — the same reason `PrismaModule` is global.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: OBJECT_STORE,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService): ObjectStore => {
        const driver = config.get<string>('OBJECT_STORE_DRIVER') ?? 'postgres';
        if (driver === 'r2') {
          /*
            Constructed eagerly, so a missing credential is a boot failure rather than a
            failed upload an hour later. `configuration.ts` has already refused a half-filled
            set by this point; this is the second line of the same defence, and it costs one
            object construction.
          */
          const store = new R2ObjectStore(config);
          new Logger('StorageModule').log(
            'Object store: Cloudflare R2. New uploads go to the bucket; rows that still hold ' +
              'their own bytes keep reading from the database until the backfill moves them.',
          );
          return store;
        }
        new Logger('StorageModule').log(
          'Object store: PostgreSQL. Set OBJECT_STORE_DRIVER=r2 with an R2 account to move ' +
            'objects out of the database.',
        );
        return new PostgresObjectStore(prisma);
      },
    },
    ObjectStoreService,
  ],
  exports: [ObjectStoreService, OBJECT_STORE],
})
export class StorageModule {}
