import { Redirect } from 'expo-router';

/**
 * Entry point. Always lands on the tabs.
 *
 * It used to send unauthenticated visitors to the welcome/sign-in flow. That is the
 * wrong first screen for a ticketing app: the API serves discovery publicly and
 * supports guest checkout, so an account is only needed at the point a booking becomes
 * attached to a person. The screens that do need one (tickets, account actions) prompt
 * in place via AuthGate, which keeps the user where they were.
 */
export default function Index() {
  return <Redirect href="/(tabs)" />;
}
