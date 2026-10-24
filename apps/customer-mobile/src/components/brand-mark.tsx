import { View } from 'react-native';
import { Text } from '@/ui';

/**
 * The storefront's wordmark: "ETicketsGo" in the display face with a gold full stop
 * (apps/customer-web, the site header and footer). The dot is decorative gold, a fill; the
 * letters are ink, or paper on a stage band.
 */
export function BrandMark({
  size = 'md',
  onStage = false,
}: {
  size?: 'md' | 'lg';
  onStage?: boolean;
}) {
  const md = size === 'md';
  return (
    <View
      className="flex-row items-end"
      accessible
      accessibilityRole="header"
      accessibilityLabel="ETicketsGo"
    >
      <Text
        variant={md ? 'd3' : 'd1'}
        tone={onStage ? 'onStage' : 'primary'}
        className="font-extrabold"
        style={{ letterSpacing: md ? -0.6 : -1 }}
      >
        ETicketsGo
      </Text>
      <View
        className="rounded-full bg-gold"
        style={{
          width: md ? 6 : 9,
          height: md ? 6 : 9,
          marginLeft: 1,
          marginBottom: md ? 5 : 7,
        }}
      />
    </View>
  );
}
