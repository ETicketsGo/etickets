import { Link, Stack } from 'expo-router';
import { Text, View } from 'react-native';
import { Screen } from '@/components/screen';

export default function NotFound() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Screen>
        <View className="flex-1 items-center justify-center gap-3">
          <Text className="text-lg font-semibold text-text-primary">
            This screen doesn&rsquo;t exist.
          </Text>
          <Link href="/" className="text-action-primary">
            Go home
          </Link>
        </View>
      </Screen>
    </>
  );
}
