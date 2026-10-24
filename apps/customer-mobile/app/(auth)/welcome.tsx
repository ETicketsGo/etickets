import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/screen';
import { BrandMark } from '@/components/brand-mark';
import { Button, GoldRule, Text } from '@/ui';

/**
 * Welcome: the brand on a stage, one line, two ways in. Not routed to today (the app opens
 * on Home, browsable without an account), kept in the storefront's look for when it is.
 */
export default function Welcome() {
  const router = useRouter();
  return (
    <Screen tone="stage">
      <View className="flex-1 justify-between py-10">
        <View className="mt-24 gap-5">
          <BrandMark size="lg" onStage />
          <GoldRule />
          <Text variant="d2" tone="onStage">
            Films, live shows and experiences, with every fee shown before you pay.
          </Text>
        </View>
        <View className="gap-3">
          <Button
            label="Browse what is on"
            variant="gold"
            size="lg"
            onPress={() => router.replace('/(tabs)')}
          />
          <Button
            label="Sign in"
            variant="secondary"
            size="lg"
            onPress={() => router.replace('/(auth)/login')}
          />
        </View>
      </View>
    </Screen>
  );
}
