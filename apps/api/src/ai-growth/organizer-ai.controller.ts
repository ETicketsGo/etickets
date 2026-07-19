import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { OrganizerAiService } from './organizer-ai.service';
import { ContentService, type ContentDraftInput } from './content.service';
import { CurrentUser, type RequestUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const askSchema = z.object({
  organizationId: z.string().min(1),
  question: z.string().trim().min(3).max(500),
});

const draftSchema = z.object({
  kind: z.enum(['description', 'caption', 'email', 'faq', 'reminder', 'social']),
  title: z.string().trim().min(2).max(200),
  city: z.string().trim().max(120).optional(),
  venue: z.string().trim().max(200).optional(),
  dateText: z.string().trim().max(120).optional(),
  highlights: z.string().trim().max(500).optional(),
});

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class OrganizerAiController {
  constructor(
    private readonly organizerAi: OrganizerAiService,
    private readonly content: ContentService,
  ) {}

  @Get('events/:eventId/summary')
  @ApiOperation({ summary: 'Deterministic event performance summary (AI-optional).' })
  summary(@CurrentUser() user: RequestUser, @Param('eventId') eventId: string) {
    return this.organizerAi.eventSummary(user, eventId);
  }

  @Get('events/:eventId/recommendations')
  @ApiOperation({ summary: 'Explainable, advisory growth recommendations.' })
  recommendations(@CurrentUser() user: RequestUser, @Param('eventId') eventId: string) {
    return this.organizerAi.growthRecommendations(user, eventId);
  }

  @Post('organizer/ask')
  @ApiOperation({ summary: 'Organizer assistant — answers from authorized org analytics.' })
  ask(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(askSchema)) body: { organizationId: string; question: string },
  ) {
    return this.organizerAi.ask(user, body.organizationId, body.question);
  }

  @Post('content/draft')
  @ApiOperation({ summary: 'Draft event copy from organizer-provided facts (review required).' })
  draft(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(draftSchema)) body: ContentDraftInput,
  ) {
    return this.content.draft(user, body);
  }
}
