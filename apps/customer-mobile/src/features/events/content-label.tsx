import { View } from 'react-native';
import { Text } from '@/ui';

/**
 * The storefront's "Sample event" / "Test event" pill (QA's seeded catalogue, the API's
 * `contentLabel`). Outlined, never a fill: it is a caveat, not a status.
 */
export function contentLabelText(label: string | null | undefined): string | null {
  switch (label?.toUpperCase()) {
    case 'DEMO':
      return 'Sample event';
    case 'TEST':
      return 'Test event';
    default:
      return null;
  }
}

export function ContentLabelPill({
  label,
  onStage = false,
  centered = false,
}: {
  label: string | null | undefined;
  onStage?: boolean;
  centered?: boolean;
}) {
  const text = contentLabelText(label);
  if (!text) return null;
  return (
    <View
      style={{ minHeight: 22 }}
      className={`justify-center ${centered ? 'self-center' : 'self-start'} rounded-full border px-2 ${
        onStage ? 'border-stage-line-strong' : 'border-border-strong'
      }`}
    >
      <Text variant="meta" tone={onStage ? 'onStage2' : 'secondary'} className="font-medium">
        {text}
      </Text>
    </View>
  );
}
