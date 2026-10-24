import { Switch, type SwitchProps } from 'react-native';
import { palette } from '@/theme';

/**
 * The brand's switch: ink when on, a warm grey track when off, a white thumb. The platform
 * default is Material teal on Android, which is nobody's colour here.
 */
export function Toggle(
  props: Omit<SwitchProps, 'trackColor' | 'thumbColor' | 'ios_backgroundColor'>,
) {
  return (
    <Switch
      {...props}
      trackColor={{ false: palette.borderStrong, true: palette.text }}
      thumbColor="#FFFFFF"
      ios_backgroundColor={palette.borderStrong}
    />
  );
}
