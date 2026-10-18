export function configuredGitHubAppId(value: string | undefined): string | null {
  const appId = value?.trim();
  return appId && /^[1-9]\d*$/.test(appId) ? appId : null;
}

export function configuredGitHubInstallUrl(value: string | undefined): URL | null {
  if (!value) return null;

  let installUrl: URL;
  try {
    installUrl = new URL(value);
  } catch {
    return null;
  }

  const appSlug = installUrl.pathname.match(/^\/apps\/([A-Za-z0-9-]+)\/installations\/new$/)?.[1];
  if (
    installUrl.origin !== 'https://github.com' ||
    installUrl.username ||
    installUrl.password ||
    !appSlug ||
    /^replace(?:-|$)/i.test(appSlug) ||
    installUrl.search ||
    installUrl.hash
  ) return null;

  return installUrl;
}

export function isGitHubAppConfigured(
  appId: string | undefined,
  installUrl: string | undefined,
  privateKey: string | undefined
): boolean {
  return configuredGitHubAppId(appId) !== null &&
    configuredGitHubInstallUrl(installUrl) !== null &&
    Boolean(privateKey?.trim());
}
