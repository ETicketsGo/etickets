-- Payment void states (ADR-043 P5.3B Phase 5). AUTHORIZED (authorized-not-captured, voidable)
-- and VOIDED (authorization cancelled before capture — no funds moved, never a refund). Additive;
-- existing rows/behaviour unchanged. Void execution is off by default + production-forbidden.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'AUTHORIZED' BEFORE 'SUCCEEDED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'VOIDED' BEFORE 'REFUNDED';
