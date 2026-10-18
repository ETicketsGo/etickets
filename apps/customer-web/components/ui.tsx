// Re-export the shared UI kit so customer-web pages import from one source.
// ButtonLink is the storefront's own, so every button link keeps the reader's locale.
export { ButtonLink } from './button-link';
// These carry built-in words ("Try again", "Close", "Progress", star labels) or the brand frame,
// so the storefront's versions pass them in. Import them from here, not web-kit.
export { Dialog, Drawer, ErrorState, RatingStars, Stepper } from './localized-ui';
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
  Toggle,
  useToast,
} from '@eticketsgo/web-kit';
