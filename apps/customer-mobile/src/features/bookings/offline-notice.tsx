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
      className={`mx-5 mb-3 flex-row items-start gap-2 rounded-md px-3 py-2.5 ${
        stale ? 'bg-status-error/12' : 'bg-status-warning/15'
      }`}
    >
      <Ionicons
        name={stale ? 'warning-outline' : 'cloud-offline-outline'}
        size={16}
        color={stale ? '#DC2626' : '#D97706'}
      />
      <View className="flex-1">
        <Text variant="subhead" tone={stale ? 'danger' : 'secondary'}>
          {stale ? 'These saved tickets are out of date' : 'Showing saved tickets'}
        </Text>
        <Text variant="caption" tone="muted">
          {syncedAt ? describeFreshness(syncedAt) : 'Last sync time unknown'}
          {stale
            ? ' — reconnect to confirm they are still valid before you travel.'
            : ' — reconnect to check for changes.'}
        </Text>
      </View>
    </View>
  );
}
