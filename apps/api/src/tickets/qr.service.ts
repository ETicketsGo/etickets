import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppException, ErrorCodes } from '../common/errors';

export interface QrPayload {
  ticketId: string;
  eventSessionId: string;
  issuedAt: number;
  nonce: string;
  version: number;
  signature: string;
}

/** Signs and verifies QR ticket tokens. The payload is signed, not just an id. */
@Injectable()
export class QrService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('QR_SIGNING_SECRET');
  }

  private computeSignature(p: Omit<QrPayload, 'signature'>): string {
    const canonical = `${p.ticketId}.${p.eventSessionId}.${p.issuedAt}.${p.nonce}.${p.version}`;
    return createHmac('sha256', this.secret).update(canonical).digest('hex');
  }

  sign(input: {
    ticketId: string;
    eventSessionId: string;
    nonce: string;
    version: number;
  }): string {
    const base = { ...input, issuedAt: Date.now() };
    const signature = this.computeSignature(base);
    const payload: QrPayload = { ...base, signature };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  verify(token: string): QrPayload {
    let payload: QrPayload;
    try {
      payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as QrPayload;
    } catch {
      throw new AppException(
        ErrorCodes.QR_INVALID,
        'Unreadable ticket code.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!payload?.ticketId || !payload.signature) {
      throw new AppException(
        ErrorCodes.QR_INVALID,
        'Malformed ticket code.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const expected = this.computeSignature(payload);
    const a = Buffer.from(expected);
    const b = Buffer.from(payload.signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppException(
        ErrorCodes.QR_INVALID,
        'Ticket signature is invalid.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return payload;
  }
}
