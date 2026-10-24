import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/ui';
import { describeFreshness } from '@/services/ticket-cache';

/**
 * Says, above cached tickets, that they are cached and when they were last checked.
 *
 * This is not garnish. A ticket that was cancelled or refunded after the last sync
 * still renders from disk exactly as it did when valid, and the only thing standing
 * between that and an argument at a gate is the app being honest about what it is
 * showing and how old it is.
 */
export function OfflineTicketNotice({
  syncedAt,
  stale,
}: {
  syncedAt: number | null;
  stale: boolean;
}) {
  return (
    <View
      accessibilityRole="alert"
      className={`flex-row items-start gap-3 rounded-card px-4 py-3 ${
        stale ? 'bg-critical-tint' : 'bg-caution-tint'
      }`}
    >
      <Ionicons
        name={stale ? 'warning-outline' : 'cloud-offline-outline'}
        size={16}
        color={stale ? '#B51D29' : '#84652F'}
      />
      <View className="flex-1">
        <Text variant="uiStrong" tone={stale ? 'danger' : 'primary'}>
          {stale ? 'These saved tickets are out of date' : 'Showing saved tickets'}
        </Text>
        <Text variant="meta" tone="secondary">
          {syncedAt ? describeFreshness(syncedAt) : 'Last sync time unknown'}
          {stale
            ? '. Reconnect to confirm they are still valid before you travel.'
            : '. Reconnect to check for changes.'}
        </Text>
      </View>
    </View>
  );
}
