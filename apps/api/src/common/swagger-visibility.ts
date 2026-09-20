/**
 * Whether this process should publish its own API reference.
 *
 * ── WHY THIS IS A FUNCTION AND NOT TWO LINES IN `main.ts` ──────────────────────────
 * Because it is a security decision with three inputs and one environment where the answer
 * is not negotiable, and that deserves a test rather than a boolean expression nobody reads
 * during a deploy.
 *
 * ── WHY `APP_ENV` DECIDES WHAT PRODUCTION IS, AND NOT `NODE_ENV` ───────────────────
 * QA and UAT both run with `NODE_ENV=production`, so a guard written against it means
 * something different in every environment: it reads as "not production" only on a
 * developer's laptop. This repository has been caught by that shape before, which is why
 * `APP_ENV` is the one that names where the process is running.
 *
 * ── WHAT THE RULE IS ───────────────────────────────────────────────────────────────
 * Production never publishes it, whatever any variable says. Everywhere else the previous
 * behaviour is kept exactly: on when this is not a production BUILD, and otherwise only when
 * somebody asked for it with `ENABLE_SWAGGER=true`. That keeps a developer's machine and QA
 * as they are, and UAT off, while removing the one path that could expose the whole API
 * surface in production -- a variable copied from the QA template into the wrong project.
 */
export interface SwaggerVisibilityEnv {
  APP_ENV?: string;
  NODE_ENV?: string;
  ENABLE_SWAGGER?: string;
}

export interface SwaggerVisibility {
  enabled: boolean;
  /** Set when production was asked to publish and refused, so the boot log can say so. */
  refusedInProduction: boolean;
}

export function swaggerVisibility(env: SwaggerVisibilityEnv): SwaggerVisibility {
  const asked = env.ENABLE_SWAGGER === 'true';
  const isProduction = (env.APP_ENV ?? '').trim().toUpperCase() === 'PRODUCTION';

  if (isProduction) {
    // Reported rather than ignored: a variable that does nothing is a belief somebody holds.
    return { enabled: false, refusedInProduction: asked };
  }

  return {
    enabled: env.NODE_ENV !== 'production' || asked,
    refusedInProduction: false,
  };
}
