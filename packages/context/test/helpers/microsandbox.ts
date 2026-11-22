type MicrosandboxSdk = typeof import('microsandbox');

export async function importMicrosandboxSdk(): Promise<
  MicrosandboxSdk | undefined
> {
  try {
    return await import('microsandbox');
  } catch {
    return undefined;
  }
}

/**
 * Import success is not enough — the runtime needs hardware virtualization
 * (Apple silicon / Linux KVM), so the probe boots a real throwaway microVM,
 * mirroring the Apple container suite's usability guard.
 */
export async function isMicrosandboxUsable(): Promise<boolean> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return false;
  }
  const sdk = await importMicrosandboxSdk();
  if (!sdk) return false;
  try {
    await using probe = await sdk.Sandbox.builder(
      `deepagents-probe-${process.pid}`,
    )
      .image('alpine')
      .ephemeral(true)
      .replace()
      .create();
    const result = await probe.shell('echo ok');
    return result.success;
  } catch {
    return false;
  }
}
