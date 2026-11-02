/**
 * The Fly Machines API calls the free starter agents need: one Machine per
 * agent in one Fly app. Every call is a plain HTTPS request with the app's
 * scoped token; nothing here keeps state.
 */
export interface FreeAgentMachineSpec {
  /** Stable lookup key: the agent identity this Machine hosts. */
  agentId: string;
  image: string;
  region: string;
  env: Record<string, string>;
  cpus: number;
  memoryMb: number;
}

export interface FreeAgentMachines {
  /** Create and boot one Machine; returns its Fly id. */
  create(spec: FreeAgentMachineSpec): Promise<{ id: string }>;
  /** The Machine already created for this agent, if any. */
  find(agentId: string): Promise<{ id: string; state: string } | undefined>;
  /** Start a stopped Machine or resume a suspended one. */
  start(id: string, image?: string): Promise<void>;
  suspend(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  /** Current Fly state (`started`, `suspended`, `stopped`, ...), or undefined when gone. */
  state(id: string): Promise<string | undefined>;
  /** Resolve once the Machine reaches `state` (Fly's own wait), or reject after the timeout. */
  waitFor(id: string, state: 'suspended' | 'stopped', timeoutSeconds: number): Promise<void>;
}

export class FlyApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly operation: string,
  ) {
    super(`Fly ${operation} failed: HTTP ${status} ${body.slice(0, 300)}`);
    this.name = 'FlyApiError';
  }
}

export class FlyMachines implements FreeAgentMachines {
  readonly #base: string;

  constructor(
    private readonly token: string,
    readonly app: string,
    private readonly fetchImpl: typeof fetch = fetch,
    apiOrigin = 'https://api.machines.dev',
  ) {
    this.#base = `${apiOrigin.replace(/\/$/, '')}/v1/apps/${encodeURIComponent(app)}/machines`;
  }

  async create(spec: FreeAgentMachineSpec): Promise<{ id: string }> {
    const machine = await this.#request<{ id: string }>('create', '', 'POST', {
      name: `free-agent-${spec.agentId.slice(0, 16)}-${Date.now().toString(36)}`,
      region: spec.region,
      config: {
        image: spec.image,
        env: spec.env,
        guest: { cpu_kind: 'shared', cpus: spec.cpus, memory_mb: spec.memoryMb },
        // The agent's files and the helper's state live on the root
        // filesystem; keeping it across stop/start removes the need for a volume.
        rootfs: { persist: 'always' },
        // The server decides when this Machine runs. A crash stays down until
        // the next wake starts it again.
        restart: { policy: 'no' },
        metadata: { beeline_agent: spec.agentId },
      },
    });
    return { id: machine.id };
  }

  async find(agentId: string): Promise<{ id: string; state: string } | undefined> {
    const machines = await this.#request<Array<{ id: string; state: string }>>(
      'list',
      `?metadata.beeline_agent=${encodeURIComponent(agentId)}`,
      'GET',
    );
    return machines.find((machine) => machine.state !== 'destroyed');
  }

  async start(id: string, image?: string): Promise<void> {
    if (image) {
      const machine = await this.#request<{ state: string; version: string; config: Record<string, unknown> & { image: string } }>(
        'get', `/${id}`, 'GET');
      const sameImage = machine.config.image === image ||
        (image.includes('@sha256:') && machine.config.image.split('@')[1] === image.split('@')[1]);
      if (!sameImage) {
        if (machine.state === 'started' || machine.state === 'suspended') {
          await this.stop(id);
          await this.waitFor(id, 'stopped', 30);
        }
        await this.#request('update image', `/${id}`, 'POST', {
          current_version: machine.version,
          skip_launch: true,
          config: { ...machine.config, image },
        });
      }
    }
    // Fly can report suspended before its snapshot transition accepts a start.
    // Retry that short transition here, rather than leaving a live connection
    // to suppress the next wake until its heartbeat expires.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#request('start', `/${id}/start`, 'POST', {});
        return;
      } catch (error) {
        if (!(error instanceof FlyApiError) || error.status !== 412 || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2_000)));
      }
    }
  }

  async suspend(id: string): Promise<void> {
    await this.#request('suspend', `/${id}/suspend`, 'POST', {});
  }

  async stop(id: string): Promise<void> {
    await this.#request('stop', `/${id}/stop`, 'POST', {});
  }

  async destroy(id: string): Promise<void> {
    try {
      await this.#request('destroy', `/${id}?force=true`, 'DELETE');
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) return;
      throw error;
    }
  }

  async waitFor(id: string, state: 'suspended' | 'stopped', timeoutSeconds: number): Promise<void> {
    await this.#request('wait', `/${id}/wait?state=${state}&timeout=${timeoutSeconds}`, 'GET');
  }

  async state(id: string): Promise<string | undefined> {
    try {
      return (await this.#request<{ state: string }>('get', `/${id}`, 'GET')).state;
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async #request<T = unknown>(
    operation: string,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new FlyApiError(response.status, text, operation);
    return (text ? JSON.parse(text) : {}) as T;
  }
}
