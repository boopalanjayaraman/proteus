import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

/**
 * The credential vault.
 *
 * A GitHub PAT is written here once, during project creation, and read only by
 * the GitHub adapter at the moment of a call. It never enters MongoDB, never
 * appears in a response, and never reaches a log — design rule 8.
 *
 * Behind an interface so tests can run without a GCP project. The interface is
 * narrow on purpose: `read` takes a pinned version, because a migration that
 * begins under one token and finishes under another cannot be audited.
 */
export interface StoredSecret {
  /** `proteus-{projectId}-github-pat` */
  name: string;
  /** A concrete version number, never "latest". */
  version: string;
}

export interface SecretVault {
  /** Creates the secret and its first version. Returns the pinned reference. */
  store(name: string, value: string): Promise<StoredSecret>;
  /** Adds a version to an existing secret, for rotation. */
  addVersion(name: string, value: string): Promise<StoredSecret>;
  /** Reads one pinned version. The only path by which a token leaves the vault. */
  read(ref: StoredSecret): Promise<string>;
  /** Removes the secret and every version. Called when a project is deleted. */
  destroy(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
}

export class SecretVaultError extends Error {}

export class GcpSecretVault implements SecretVault {
  private readonly client = new SecretManagerServiceClient();

  constructor(private readonly projectId: string) {}

  private parent(): string {
    return `projects/${this.projectId}`;
  }

  async store(name: string, value: string): Promise<StoredSecret> {
    try {
      await this.client.createSecret({
        parent: this.parent(),
        secretId: name,
        secret: { replication: { automatic: {} } },
      });
    } catch (e) {
      // Already exists is fine — add a version to it instead.
      if (!isAlreadyExists(e)) {
        throw new SecretVaultError(`could not create secret ${name}: ${(e as Error).message}`);
      }
    }
    return this.addVersion(name, value);
  }

  async addVersion(name: string, value: string): Promise<StoredSecret> {
    const [version] = await this.client.addSecretVersion({
      parent: `${this.parent()}/secrets/${name}`,
      payload: { data: Buffer.from(value, 'utf8') },
    });
    // "projects/p/secrets/s/versions/3" -> "3". Pinned, never "latest".
    const versionNumber = version.name?.split('/').pop();
    if (!versionNumber) throw new SecretVaultError(`no version returned for ${name}`);
    return { name, version: versionNumber };
  }

  async read(ref: StoredSecret): Promise<string> {
    const [accessed] = await this.client.accessSecretVersion({
      name: `${this.parent()}/secrets/${ref.name}/versions/${ref.version}`,
    });
    const data = accessed.payload?.data;
    if (!data) throw new SecretVaultError(`secret ${ref.name}@${ref.version} has no payload`);
    return Buffer.from(data as Uint8Array).toString('utf8');
  }

  async destroy(name: string): Promise<void> {
    try {
      await this.client.deleteSecret({ name: `${this.parent()}/secrets/${name}` });
    } catch (e) {
      if (!isNotFound(e)) throw new SecretVaultError(`could not delete ${name}: ${(e as Error).message}`);
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client.getSecret({ name: `${this.parent()}/secrets/${name}` });
      return true;
    } catch {
      return false;
    }
  }
}

/** For tests and local development without a GCP project. */
export class InMemorySecretVault implements SecretVault {
  private readonly secrets = new Map<string, string[]>();

  async store(name: string, value: string): Promise<StoredSecret> {
    if (!this.secrets.has(name)) this.secrets.set(name, []);
    return this.addVersion(name, value);
  }

  async addVersion(name: string, value: string): Promise<StoredSecret> {
    const versions = this.secrets.get(name) ?? [];
    versions.push(value);
    this.secrets.set(name, versions);
    return { name, version: String(versions.length) };
  }

  async read(ref: StoredSecret): Promise<string> {
    const value = this.secrets.get(ref.name)?.[Number(ref.version) - 1];
    if (value === undefined) throw new SecretVaultError(`no such secret ${ref.name}@${ref.version}`);
    return value;
  }

  async destroy(name: string): Promise<void> {
    this.secrets.delete(name);
  }

  async exists(name: string): Promise<boolean> {
    return this.secrets.has(name);
  }

  /** Test-only: what is actually held, to assert a secret was or was not written. */
  get names(): string[] {
    return [...this.secrets.keys()];
  }

  /** Test-only. Without this the vault outlives a cleared database, project ids
   *  repeat, and secret versions accumulate across unrelated tests. */
  clear(): void {
    this.secrets.clear();
  }
}

/** `proteus-PQC-0184-github-pat` */
export function githubSecretName(projectId: string): string {
  return `proteus-${projectId}-github-pat`;
}

function isAlreadyExists(e: unknown): boolean {
  return (e as { code?: number })?.code === 6;
}
function isNotFound(e: unknown): boolean {
  return (e as { code?: number })?.code === 5;
}
