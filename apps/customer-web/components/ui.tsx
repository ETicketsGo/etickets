// Re-export the shared UI kit so customer-web pages import from one source.
// ButtonLink is the storefront's own, so every button link keeps the reader's locale.
export { ButtonLink } from './button-link';
// These four carry built-in words ("Try again", "Close", "Progress", star labels), so the
// storefront's versions pass them in the reader's language. Import them from here, not web-kit.
export { Drawer, ErrorState, RatingStars, Stepper } from './localized-ui';
export {
  Button,
  Input,
  Textarea,
  Select,
  Card,
  Badge,
  StatusBadge,
  EmptyState,
  Skeleton,
  Spinner,
  Dialog,
  Toggle,
  useToast,
} from '@eticketsgo/web-kit';
