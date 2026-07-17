import type { Metadata } from 'next';
import { Container, Section } from '@/components/marketing/kit';
import { PageHero, Prose } from '@/components/marketing/blocks';

export const metadata: Metadata = {
  title: 'API reference',
  description:
    'ETicketsGo API conventions — authentication, pagination, errors, webhooks, and the interactive OpenAPI/Swagger reference.',
  alternates: { canonical: '/docs/api' },
};

export default function ApiDocsPage() {
  return (
    <>
      <PageHero
        eyebrow="Documentation · API"
        title="ETicketsGo API"
        lead="A predictable REST API with an always-in-sync OpenAPI reference."
      />
      <Section>
        <Container className="max-w-3xl">
          <Prose>
            <h2>Interactive reference</h2>
            <p>
              The API is documented with OpenAPI/Swagger, generated from the code — it lists every
              route, request/response shape, and auth requirement. It is served at{' '}
              <code>/api/docs</code> in non-production environments.
            </p>
            <h2>Conventions</h2>
            <ul>
              <li>
                <strong>Base path:</strong> all routes are under <code>/api</code>.
              </li>
              <li>
                <strong>Auth:</strong> <code>Authorization: Bearer &lt;accessToken&gt;</code>.
                Obtain via <code>POST /api/auth/login</code>; refresh via{' '}
                <code>POST /api/auth/refresh</code> (rotating refresh tokens with reuse detection).
              </li>
              <li>
                <strong>Validation:</strong> request bodies are validated; unknown keys are
                stripped.
              </li>
              <li>
                <strong>Pagination:</strong> list endpoints take <code>page</code> and{' '}
                <code>pageSize</code> (capped at 100) and return <code>{'{ data, meta }'}</code>.
              </li>
              <li>
                <strong>Errors:</strong> a normalized envelope{' '}
                <code>{'{ code, message, details, correlationId }'}</code>. Payment failures map to
                clear statuses (402 declined, 409 duplicate, 503 provider unavailable).
              </li>
              <li>
                <strong>Idempotency:</strong> money, inventory, and check-in transitions are
                idempotent and replay-safe.
              </li>
            </ul>
            <h2>Webhooks</h2>
            <p>
              Payment providers call <code>POST /api/payments/webhook/:provider</code> — signed,
              idempotent, and replay-safe.
            </p>
            <h2>Health & metrics</h2>
            <p>
              <code>GET /api/health</code> (liveness), <code>GET /api/health/ready</code> (database
              + Redis), and <code>GET /api/metrics</code> (Prometheus).
            </p>
          </Prose>
        </Container>
      </Section>
    </>
  );
}
