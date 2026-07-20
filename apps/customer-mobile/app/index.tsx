import { Redirect } from 'expo-router';
import { useAuth } from '@/hooks/use-auth';

/** Auth gate: route to the app or the auth flow once the session is resolved. */
export default function Index() {
  const { isAuthenticated } = useAuth();
  return <Redirect href={isAuthenticated ? '/(app)' : '/(auth)/welcome'} />;
}
