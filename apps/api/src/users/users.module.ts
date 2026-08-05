import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AccountDeletionService } from './account-deletion.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  controllers: [UsersController, DevicesController],
  providers: [UsersService, AccountDeletionService, DevicesService],
  exports: [UsersService, AccountDeletionService, DevicesService],
})
export class UsersModule {}
