-- Provider-authoritative reservation states (ADR-042 §4, P5.2B Slice 3). Added to the
-- BookingWorkflowState enum so a durable workflow can represent the external-provider
-- temporary reservation before payment. Additive; existing rows/behaviour unchanged.
ALTER TYPE "BookingWorkflowState" ADD VALUE IF NOT EXISTS 'PROVIDER_RESERVATION_PENDING' BEFORE 'PAYMENT_PENDING';
ALTER TYPE "BookingWorkflowState" ADD VALUE IF NOT EXISTS 'PROVIDER_RESERVED' BEFORE 'PAYMENT_PENDING';
