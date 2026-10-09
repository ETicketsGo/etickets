import { Controller, Get, Logger, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { EventAttendeesService } from './event-attendees.service';
import { ATTENDEE_STATES, CHECK_IN_FILTERS, type AttendeeFilter } from './event-attendees.query';

/** The filter, exactly as the screen and the export both accept it. */
const filterSchema = z.object({
  sessionId: z.string().min(1).max(64).optional(),
  ticketTypeId: z.string().min(1).max(64).optional(),
  status: z.enum(ATTENDEE_STATES).optional(),
  checkIn: z.enum(CHECK_IN_FILTERS).optional(),
  q: z.string().max(200).optional(),
});

const listSchema = filterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

type ListQuery = AttendeeFilter & { page: number; pageSize: number };

@ApiTags('events')
@ApiBearerAuth()
@Controller('events')
export class EventAttendeesController {
  private readonly logger = new Logger('AttendeeExport');

  constructor(private readonly attendees: EventAttendeesService) {}

  @Get(':id/attendees')
  @ApiOperation({
    summary: 'Who booked this event: filtered, paged, with per-status totals.',
  })
  list(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(listSchema)) q: ListQuery,
  ) {
    const { page, pageSize, ...filter } = q;
    return this.attendees.list(user, id, filter, page, pageSize);
  }

  /**
   * The same rows as the list under the same filter, as a CSV download.
   *
   * Authorized before any header is set, so a refusal is an ordinary JSON 403/404. After the
   * first byte the status is committed; a failure mid-stream ends the response early, and the
   * audit row records `completed: false` with however many rows had been written.
   */
  @Get(':id/attendees/export')
  @ApiOperation({ summary: 'Export the filtered attendee list as CSV (owners and managers).' })
  async export(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(filterSchema)) filter: AttendeeFilter,
    @Res() res: Response,
  ) {
    const ctx = await this.attendees.authorizeExport(user, id);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${this.attendees.exportFilename(ctx)}"`,
    );
    // The consoles fetch this cross-origin; without this the browser hides the file name.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    // A list of people's names and addresses must not sit in a shared or browser cache.
    res.setHeader('Cache-Control', 'no-store');
    try {
      await this.attendees.writeExport(
        user,
        ctx,
        filter,
        (chunk) =>
          new Promise<void>((resolve, reject) => {
            if (res.destroyed) return reject(new Error('Client went away during export.'));
            if (res.write(chunk)) return resolve();
            res.once('drain', resolve);
            res.once('close', resolve);
          }),
      );
      res.end();
    } catch (err) {
      this.logger.warn(`Attendee export for event ${id} ended early: ${(err as Error).message}`);
      res.destroy();
    }
  }
}
