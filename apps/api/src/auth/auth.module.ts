import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { PhoneOtpService } from './phone-otp.service';
import { PhoneOtpDeliverySink } from './phone-otp-delivery.sink';
import { OtpSmsGuard } from './otp-sms-guard';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { MfaController } from './mfa/mfa.controller';
import { MfaGuard } from './mfa/mfa.guard';
import { MfaService } from './mfa/mfa.service';
import { LoginBackoff } from './login-backoff';
import { AuthHandoffService } from './handoff.service';
import { EmailVerificationService } from './email-verification.service';
import { AuthRecordRetentionService } from './auth-record-retention.service';
// Password reset tells the account holder, by email, that somebody asked.
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PassportModule, JwtModule.register({}), NotificationsModule],
  controllers: [AuthController, MfaController],
  providers: [
    AuthService,
    JwtStrategy,
    PhoneOtpService,
    // Matches the SMS provider's delivery report to the sign-in code it was about.
    PhoneOtpDeliverySink,
    OtpSmsGuard,
    MfaService,
    MfaGuard,
    LoginBackoff,
    AuthHandoffService,
    EmailVerificationService,
    // Worker-driven retention purge of expired one-time auth records (dry run by default).
    AuthRecordRetentionService,
  ],
  // EmailVerificationService: a team invitation is accepted only once the email is proved.
  exports: [AuthService, MfaService, EmailVerificationService, AuthRecordRetentionService],
})
export class AuthModule {}
