import { Component, type ReactNode } from 'react';
import { Screen } from './screen';
import { ErrorState } from './states';
import { Sentry } from '@/services/sentry';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

/** App-wide error boundary: reports to Sentry and shows a recoverable error screen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    Sentry.captureException(error);
  }

  reset = () => this.setState({ hasError: false });

  render() {
    if (this.state.hasError) {
      return (
        <Screen>
          <ErrorState
            title="The app hit a snag"
            message="We've logged it. Try again."
            onRetry={this.reset}
          />
        </Screen>
      );
    }
    return this.props.children;
  }
}
