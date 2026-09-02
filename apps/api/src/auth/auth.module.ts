import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { PhoneOtpService } from './phone-otp.service';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
// Password reset tells the account holder, by email, that somebody asked.
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PassportModule, JwtModule.register({}), NotificationsModule],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, PhoneOtpService],
  exports: [AuthService],
})
export class AuthModule {}
