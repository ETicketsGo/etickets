import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { EventPicture } from '../event-picture';

jest.mock('@/services/env', () => ({ env: { apiUrl: 'https://api.example.test/api' } }));

/**
 * What a card and the event page actually draw: the copy in a box of its own shape, or the
 * fallback. Rendered, because "the URL is right" is not the same claim as "the image is shown".
 */

const withPicture = {
  imagePath: '/public/events/ev_1/images/img_1',
  imageVariants: {
    card: '/public/events/ev_1/images/img_1/card?v=abc',
    banner: '/public/events/ev_1/images/img_1/banner?v=abc',
  },
};

const fallback = <Text>glyph</Text>;

describe('EventPicture', () => {
  it('draws the card copy, cover-cropped into a 4:3 box', async () => {
    await render(<EventPicture event={withPicture} use="card" fallback={fallback} />);

    const image = screen.getByTestId('event-picture-image');
    // The native view receives the source as a list of candidates.
    expect(image.props.source).toEqual([
      { uri: 'https://api.example.test/api/public/events/ev_1/images/img_1/card?v=abc' },
    ]);
    expect(image.props.contentFit).toBe('cover');
    expect(screen.getByTestId('event-picture')).toHaveStyle({ aspectRatio: 4 / 3 });
    expect(screen.queryByText('glyph')).toBeNull();
  });

  it('draws the banner copy in a 16:9 box', async () => {
    await render(<EventPicture event={withPicture} use="banner" fallback={null} />);

    expect(screen.getByTestId('event-picture-image').props.source[0].uri).toMatch(
      /\/banner\?v=abc$/,
    );
    expect(screen.getByTestId('event-picture')).toHaveStyle({ aspectRatio: 16 / 9 });
  });

  it('shows the fallback, in the same shape, when the event has no picture', async () => {
    await render(
      <EventPicture
        event={{ imagePath: null, imageVariants: null }}
        use="card"
        fallback={fallback}
      />,
    );

    expect(screen.queryAllByTestId('event-picture-image')).toHaveLength(0);
    expect(screen.getByText('glyph')).toBeTruthy();
    expect(screen.getByTestId('event-picture-fallback')).toHaveStyle({ aspectRatio: 4 / 3 });
  });

  it('shows the fallback when the picture cannot be loaded', async () => {
    await render(<EventPicture event={withPicture} use="card" fallback={fallback} />);

    await fireEvent(screen.getByTestId('event-picture-image'), 'error', {
      nativeEvent: { error: 'HTTP 404' },
    });

    expect(screen.queryAllByTestId('event-picture-image')).toHaveLength(0);
    expect(screen.getByText('glyph')).toBeTruthy();
  });

  it('draws nothing at all on the event page when there is no picture', async () => {
    await render(<EventPicture event={{}} use="banner" fallback={null} />);

    expect(screen.queryByTestId('event-picture')).toBeNull();
    expect(screen.queryByTestId('event-picture-fallback')).toBeNull();
  });
});
