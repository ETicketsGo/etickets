import { ArgumentMetadata, HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';
import { AppException, ErrorCodes } from './errors';

/**
 * Validates request payloads against a Zod schema and surfaces failures in the
 * standard error envelope. Use as `@Body(new ZodValidationPipe(schema))`.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const details: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_';
        (details[key] ??= []).push(issue.message);
      }
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'The request failed validation.',
        HttpStatus.BAD_REQUEST,
        { fields: details },
      );
    }
    return result.data;
  }
}
