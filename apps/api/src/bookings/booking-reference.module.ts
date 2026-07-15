import { Module } from '@nestjs/common';
import { BookingReferenceService } from './booking-reference.service';

/**
 * Stateless reference generator. Imports nothing (it operates on the transaction
 * client passed to it), so it can be imported by PaymentsModule without creating a
 * PaymentsModule ↔ BookingsModule cycle.
 */
@Module({
  providers: [BookingReferenceService],
  exports: [BookingReferenceService],
})
export class BookingReferenceModule {}
