/**
 * Deployment-wide restrictions on operator-configured provider instances, enforced by the
 * adapters' `validateConfig` both at `config:apply` time and every time a stored instance is
 * resolved at runtime (worker, reconciliation, webhooks). A stored instance that violates them is
 * treated as an invalid configuration (alarm + quarantine), never used.
 */
export interface ProviderDeploymentPolicy {
  /**
   * `APP_ENV` of the process. `profile: "local"` instances (plain SMTP/HTTP) are usable only in
   * `local` and `test`. Undefined only when adapters are built outside a configured process
   * (unit/contract tests): then the profile is not restricted.
   */
  environment?: string | undefined;
  /**
   * `PROVIDER_ALLOWED_HOSTS`: exact hostnames, or suffixes starting with `.` (matching
   * subdomains only). Undefined or empty = no destination restriction.
   */
  allowedHosts?: readonly string[] | undefined;
}

const LOCAL_PROFILE_ENVIRONMENTS = new Set(['local', 'test']);

export function localProfileAllowed(policy: ProviderDeploymentPolicy): boolean {
  return policy.environment === undefined || LOCAL_PROFILE_ENVIRONMENTS.has(policy.environment);
}

function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  return value.replace(/\.+$/, '');
}

/** Parses the comma-separated `PROVIDER_ALLOWED_HOSTS`; undefined when unset or empty. */
export function parseAllowedHosts(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const entries = raw
    .split(',')
    .map((entry) => normalizeHost(entry))
    .filter((entry) => entry !== '' && entry !== '.');
  return entries.length > 0 ? [...new Set(entries)] : undefined;
}

export function hostAllowed(host: string, allowedHosts: readonly string[] | undefined): boolean {
  if (allowedHosts === undefined || allowedHosts.length === 0) return true;
  const candidate = normalizeHost(host);
  if (candidate === '') return false;
  return allowedHosts.some((entry) =>
    entry.startsWith('.') ? candidate.endsWith(entry) : candidate === entry,
  );
}

/** Violations of the policy for one instance; `hostField` is the JSON pointer of the host. */
export function deploymentPolicyIssues(
  policy: ProviderDeploymentPolicy,
  instance: { profile: string; host: string; hostField: string },
): string[] {
  const issues: string[] = [];
  if (instance.profile === 'local' && !localProfileAllowed(policy)) {
    issues.push(`/profile "local" is not allowed in ${String(policy.environment)}`);
  }
  if (!hostAllowed(instance.host, policy.allowedHosts)) {
    issues.push(`${instance.hostField} is not allowed by PROVIDER_ALLOWED_HOSTS`);
  }
  return issues;
}

/**
 * Policy read from the process environment, for composition roots that do not pass one
 * explicitly. Every entrypoint validates the environment first (`loadConfig`), so `APP_ENV` is
 * always set there; an unexpected value is treated as a remote environment.
 */
export function deploymentPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProviderDeploymentPolicy {
  const environment = env.APP_ENV === '' ? undefined : env.APP_ENV;
  return { environment, allowedHosts: parseAllowedHosts(env.PROVIDER_ALLOWED_HOSTS) };
}
