import { describe, expect, it } from 'vitest';
import { EVENT_CATEGORIES } from '../../lib/templates';
import {
  EXPERIENCES,
  TEMPLATE_EXPERIENCE,
  UNGROUPED_CATEGORIES,
  categoryForExperience,
  experienceForCategory,
  getExperience,
} from './experiences';

describe('the experiences on the first screen', () => {
  it('are the seven the owner asked for, in that order', () => {
    expect(EXPERIENCES.map((e) => e.label)).toEqual([
      'Concert or live music',
      'Movie screening',
      'Comedy or theatre',
      'Conference or workshop',
      'Sports',
      'Exhibition',
      'Community or other',
    ]);
  });

  it('only offer categories the API already holds, and group every one of them once', () => {
    const grouped = EXPERIENCES.flatMap((e) => e.categories);
    for (const c of grouped) expect(EVENT_CATEGORIES as readonly string[]).toContain(c);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(UNGROUPED_CATEGORIES).toEqual([]);
  });

  it('send only the film to the cinema workflow', () => {
    expect(EXPERIENCES.filter((e) => e.routesToCinema).map((e) => e.id)).toEqual(['movie']);
  });

  it('let only "community or other" type a category of its own', () => {
    expect(EXPERIENCES.filter((e) => e.allowOther).map((e) => e.id)).toEqual(['community']);
  });

  it('call a conference ticket a pass, and nothing else', () => {
    expect(getExperience('conference')?.ticketNoun).toBe('Pass');
    expect(
      EXPERIENCES.filter((e) => e.id !== 'conference').every((e) => e.ticketNoun === 'Ticket type'),
    ).toBe(true);
  });

  it('are plain ASCII', () => {
    for (const e of EXPERIENCES) {
      const text = [
        e.label,
        e.description,
        e.setsUp,
        e.sessionNoun,
        e.ticketNoun,
        e.defaultTicketName,
        e.titleExample,
        e.descriptionExample,
        ...e.ticketSuggestions,
      ].join('');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7E]*$/.test(text)).toBe(true);
    }
  });
});

describe('finding the experience of a stored category', () => {
  it('maps every listed category to its group', () => {
    expect(experienceForCategory('Music')).toBe('concert');
    expect(experienceForCategory('Theatre')).toBe('stage');
    expect(experienceForCategory('Tech')).toBe('conference');
    expect(experienceForCategory('Film')).toBe('movie');
    expect(experienceForCategory('Kids & Family')).toBe('community');
  });

  it('puts a typed category under "community or other", and says nothing for none', () => {
    expect(experienceForCategory('Poetry reading')).toBe('community');
    expect(experienceForCategory('  ')).toBe('');
  });
});

describe('the category an experience starts with', () => {
  const stage = getExperience('stage')!;

  it("keeps one already chosen that belongs to it, else takes the experience's first", () => {
    expect(categoryForExperience(stage, 'Theatre')).toBe('Theatre');
    expect(categoryForExperience(stage, 'Music')).toBe('Comedy');
    expect(categoryForExperience(stage, '')).toBe('Comedy');
  });

  it('opens every starter template on a real experience', () => {
    for (const id of Object.values(TEMPLATE_EXPERIENCE)) expect(getExperience(id)).toBeDefined();
  });

  /*
    The cards are told apart by their tile colour before a word is read, so no card may share
    a colour with the one beside it or below it - in the 2, 3 and 4 column grids it is shown in.
  */
  it('never puts two cards of the same colour next to each other', () => {
    for (const columns of [2, 3, 4]) {
      EXPERIENCES.forEach((e, i) => {
        const right = i % columns < columns - 1 ? EXPERIENCES[i + 1] : undefined;
        const below = EXPERIENCES[i + columns];
        if (right) expect(right.tone, `${e.id} beside ${right.id}`).not.toBe(e.tone);
        if (below) expect(below.tone, `${e.id} above ${below.id}`).not.toBe(e.tone);
      });
    }
  });
});
