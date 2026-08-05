import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AccountDeletionService } from './account-deletion.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, AccountDeletionService],
  exports: [UsersService, AccountDeletionService],
})
export class UsersModule {}
