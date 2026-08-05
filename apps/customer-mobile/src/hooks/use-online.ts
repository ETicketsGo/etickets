import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

/** Live connectivity state for offline banners and refetch-on-reconnect. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });
    return () => unsub();
  }, []);
  return online;
}
