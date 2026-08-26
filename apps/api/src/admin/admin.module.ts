import { Module } from '@nestjs/common';
import { AdminStaffController } from './admin-staff.controller';
import { AdminStaffService } from './admin-staff.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { MoviesModule } from '../movies/movies.module';

@Module({
  imports: [MoviesModule],
  controllers: [AdminController, AdminStaffController],
  providers: [AdminService, AdminStaffService],
})
export class AdminModule {}
