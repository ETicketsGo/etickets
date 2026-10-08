/**
 * Refuse to touch an environment whose services are not already running main.
 *
 * A Railway write that cannot skip deploys (variableDelete has no skipDeploys) makes Railway
 * build the HEAD of main for that service. On a service that is already on main that is a
 * restart; on one that is behind it is an upgrade - and for the api an unreviewed migration run.
 * That is how UAT took 13 migrations on 2026-10-08 from a "config-only" change.
 *
 * So before such a write, every service it could touch must already be on origin/main. Anything
 * behind is refused by name, unless the operator passes --allow-deploy and means it.
 */
import { execFileSync } from 'node:child_process';

export function originMainSha() {
  const out = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8' });
  const sha = out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('could not read origin/main');
  return sha;
}

/** `query(q, vars)` runs one GraphQL request with the target environment's token. */
export async function servicesBehindMain(query, { environmentId, services }, mainSha) {
  const behind = [];
  for (const { serviceId, serviceName } of services) {
    const data = await query(
      `query($e:String!,$s:String!){ deployments(first:5, input:{environmentId:$e, serviceId:$s}){ edges{ node{ status meta } } } }`,
      { e: environmentId, s: serviceId },
    );
    const live = data.deployments.edges
      .map((e) => e.node)
      .find((n) => ['SUCCESS', 'SLEEPING'].includes(n.status));
    const sha = live?.meta?.commitHash;
    // A service with no repository deployment (Postgres, Redis) is never rebuilt from main.
    if (sha && sha !== mainSha) behind.push(`${serviceName} (${sha.slice(0, 7)})`);
  }
  return behind;
}

export async function assertDeployedIsMain(query, target, { allowDeploy = false } = {}) {
  const main = originMainSha();
  const behind = await servicesBehindMain(query, target, main);
  if (behind.length && !allowDeploy) {
    throw new Error(
      `Refusing: ${behind.join(', ')} in "${target.name ?? target.environmentId}" ` +
        `${behind.length === 1 ? 'is' : 'are'} not on origin/main (${main.slice(0, 7)}). ` +
        'This write would deploy main to them. Deploy explicitly first, or pass --allow-deploy.',
    );
  }
  return { main, behind };
}
