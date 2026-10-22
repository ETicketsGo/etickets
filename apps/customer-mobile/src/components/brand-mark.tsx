import { View } from 'react-native';
import { Text } from '@/ui';

/**
 * The storefront's "E." mark (apps/customer-web/public/icon.svg) beside the ETicketsGo
 * wordmark. The dot is decorative gold; the letters take the theme's ink.
 */
export function BrandMark() {
  return (
    <View
      className="flex-row items-center gap-2"
      accessible
      accessibilityRole="header"
      accessibilityLabel="ETicketsGo"
    >
      <View className="flex-row items-end">
        <Text className="text-[26px] font-extrabold leading-[28px] text-text-primary">E</Text>
        <View className="mb-[3px] ml-[1px] h-[7px] w-[7px] rounded-full bg-[#B8955A]" />
      </View>
      <Text className="text-lg font-bold tracking-tight text-text-primary">ETicketsGo</Text>
    </View>
  );
}
