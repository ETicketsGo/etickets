import { RefreshControl, ScrollView } from 'react-native';
import { AppHeader } from '@/components/app-header';
import { Screen } from '@/components/screen';
import { OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { DiscoverySections } from '@/features/discovery/discovery-sections';
import { useDiscovery } from '@/features/discovery/api';
import { useCityPreference } from '@/features/location/api';
import { CitySuggestionBar } from '@/features/location/city-picker';

/**
 * Home: the storefront's front page on a phone. Browsable without an account, and scoped
 * to where the customer is shopping: the chosen city, or else the country the server
 * resolved for them (it shows a customer in the United States nothing from Hyderabad
 * unless they ask for it).
 */
export default function HomeScreen() {
  const online = useOnline();
  const location = useCityPreference();
  const scope = { city: location.city, country: location.scopeCountry };
  // Same query DiscoverySections reads, so pull-to-refresh reloads the sections in place.
  const { refetch, isRefetching } = useDiscovery(scope, location.ready);

  return (
    <Screen padded={false} edges={['top']}>
      <AppHeader location={location} />
      {!online ? <OfflineBanner /> : null}
      <CitySuggestionBar preference={location} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-10"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />
        }
      >
        <DiscoverySections scope={scope} ready={location.ready} />
      </ScrollView>
    </Screen>
  );
}
