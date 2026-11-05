import { setRoomEventSubscriptions } from './agent-subscriptions.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import type { FreeAgentMachines } from './fly-machines.js';
import { FlyApiError } from './fly-machines.js';
import type { LiveHub } from './live.js';
import { DEFAULT_FREE_AGENT_LIMITS, freeAgentBudgetReached } from './free-agent-limits.js';
import { captureServerError } from './sentry.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';
import { createStarterOnboardingRun } from './starter-onboarding-run.js';
import { FreeAgentConfig, createFreeAgentInWorkspace, FREE_AGENT_EVENT_SUBSCRIPTIONS, WakeCause, opaque, tokenHash, recordFreeAgentEvent, WAKE_DUE_SQL, START_LIMIT_SQL, FREE_AGENT_START_WINDOW_MINUTES, FREE_AGENT_START_LIMIT, connectorWorkSql, FreeAgentBootstrapGrant, openSecrets, FREE_AGENT_HARNESS, freeAgentHarnessModel } from './free-agents.js';



/**
 * Runtime half of free agents: provisioning, waking, sleeping, bootstrap and
 * the reaper. Every Fly call happens outside a database transaction; a
 * conditional row update decides which server instance makes it.
 */
export class FreeAgentService {
  readonly #inFlight = new Set<string>();

  constructor(
    private readonly database: SqlDatabase,
    readonly config: FreeAgentConfig,
    private readonly machines: FreeAgentMachines,
    private readonly createDaemonExchange: (
      agentId: string,
      database: SqlDatabase,
    ) => Promise<{ exchangeToken: string }>,
    private readonly log: (line: string) => void = (line) => console.log(`[free-agents] ${line}`),
  ) {}

  async createInWorkspace(
    database: SqlDatabase,
    input: { workspaceId: string; creatorId: string; roomId: string; team?: boolean; timeZone?: string },
  ): Promise<string | undefined> {
    // Serialize owner creation so simultaneous Workspaces cannot exceed the cap.
    await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`free-agent-create:${input.creatorId}`]);
    if (!input.team) return createFreeAgentInWorkspace(database, this.config, input);
    const owned = (await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM free_agents WHERE owner_id=$1`, [input.creatorId],
    )).rows[0]?.count ?? 0;
    if (owned + 2 > this.config.maxPerOwner) {
      const existing = (await database.query<{ name: string; workspace_name: string }>(
        `SELECT identity.name,workspace.name workspace_name FROM free_agents free
         JOIN identities identity ON identity.id=free.agent_id
         JOIN workspaces workspace ON workspace.id=free.workspace_id
         WHERE free.owner_id=$1 AND free.removed_at IS NULL ORDER BY free.created_at,free.agent_id`,
        [input.creatorId],
      )).rows;
      await ensureSystemIdentity(database);
      await systemLine(database, { roomId: input.roomId, authorId: SYSTEM_IDENTITY_ID,
        subject: { kind: 'system', name: systemMessage("free-agents.your-starter-agents") },
        verb: existing.length ? systemMessage("free-agents.are-already-in") : systemMessage("free-agents.could-not-be-added"),
        ...(existing.length ? { object: existing.map(agent => systemMessage("free-agents.starter-location", agent.name, agent.workspace_name)).join(systemMessage("free-agents.list-separator")) } : {}),
        consequence: systemMessage("free-agents.your-account-has-reached-its-free-agent-limit") });
      return undefined;
    }
    const beebee = await createFreeAgentInWorkspace(database, this.config, { ...input, silent: true, team: true });
    const luna = await createFreeAgentInWorkspace(database, {
      ...this.config, model: this.config.lunaModel ?? 'openai/gpt-6-luna',
    }, { ...input, name: 'Luna', silent: true, team: true });
    if (!beebee || !luna) throw new Error('starter team provisioning failed');
    for (const agent of [beebee, luna]) await setRoomEventSubscriptions(database, input.roomId, agent, FREE_AGENT_EVENT_SUBSCRIPTIONS);
    await createStarterOnboardingRun(database, { roomId: input.roomId, userId: input.creatorId, beebeeId: beebee, lunaId: luna, timeZone: input.timeZone });
    return beebee;
  }

  /** Fire-and-forget entry for a committed create or a pending wake. */
  kick(agentId: string, cause: WakeCause = 'command'): void {
    if (this.#inFlight.has(agentId)) return;
    this.#inFlight.add(agentId);
    void this.#advance(agentId, cause)
      .catch((error) =>
        this.log(`agent ${agentId.slice(0, 12)} ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => this.#inFlight.delete(agentId));
  }

  /** Bring one agent toward serving: provision when it has no Machine, otherwise wake it. */
  async #advance(agentId: string, cause: WakeCause): Promise<void> {
    if (await this.cleanupRemoved(agentId)) return;
    if (await this.provision(agentId)) return;
    await this.wake(agentId, cause);
  }

  /**
   * Create the Machine for an agent that has none. A provision is claimed for
   * two minutes so concurrent instances never create two Machines; a crash
   * mid-create is adopted by lookup on retry.
   */
  async provision(agentId: string): Promise<boolean> {
    if (await this.#budgetPaused(agentId)) return false;
    const claimed = (
      await this.database.query<{ agent_id: string }>(
        `UPDATE free_agents SET provision_started_at=clock_timestamp(),
           provision_attempts=provision_attempts+1,updated_at=now(),
           state=CASE WHEN state='destroyed' THEN 'provisioning' ELSE state END
         WHERE agent_id=$1 AND removed_at IS NULL AND fly_machine_id IS NULL AND state IN ('provisioning','destroyed')
           AND provision_attempts<5
           AND (provision_started_at IS NULL OR provision_started_at<clock_timestamp()-interval '2 minutes')
         RETURNING agent_id`,
        [agentId],
      )
    ).rows[0];
    if (!claimed) return false;
    try {
      const bootstrap = opaque('bfb');
      const active = await this.database.query(
        `UPDATE free_agents SET bootstrap_hash=$2,updated_at=now() WHERE agent_id=$1 AND removed_at IS NULL RETURNING agent_id`,
        [agentId, tokenHash(bootstrap)],
      );
      if (!active.rowCount) return false;
      const existing = await this.machines.find(agentId);
      if (existing) await this.machines.destroy(existing.id);
      const machine = await this.machines.create({
        agentId,
        image: this.config.image,
        region: this.config.region,
        cpus: this.config.cpus,
        memoryMb: this.config.memoryMb,
        env: {
          BEELINE_FREE_AGENT_ID: agentId,
          BEELINE_FREE_AGENT_MAX_TURN_SECONDS: String((this.config.limits ?? DEFAULT_FREE_AGENT_LIMITS).maxTurnMs / 1000),
          BEELINE_FREE_AGENT_BOOTSTRAP: bootstrap,
          BEELINE_SERVER_URL: this.config.publicOrigin,
          ...(this.config.installBaseUrl
            ? { BEELINE_INSTALL_BASE_URL: this.config.installBaseUrl }
            : {}),
        },
      });
      await this.database.query(
        `UPDATE free_agents SET fly_machine_id=$2,
           state=CASE WHEN removed_at IS NULL THEN 'waking' ELSE state END,
           wake_requested_at=CASE WHEN removed_at IS NULL THEN clock_timestamp() ELSE NULL END,
           provision_started_at=NULL,removal_cleaned_at=NULL,provision_error=NULL,updated_at=now()
         WHERE agent_id=$1`,
        [agentId, machine.id],
      );
      if (await this.cleanupRemoved(agentId)) return false;
      await recordFreeAgentEvent(this.database, agentId, 'provisioned', { machineId: machine.id });
      this.log(`agent ${agentId.slice(0, 12)} provisioned machine ${machine.id}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.query(
        `UPDATE free_agents SET provision_error=$2,provision_started_at=NULL,updated_at=now(),
           state=CASE WHEN provision_attempts>=5 THEN 'failed' ELSE state END
         WHERE agent_id=$1 AND removed_at IS NULL`,
        [agentId, message.slice(0, 1000)],
      );
      throw error;
    }
  }

  /**
   * Start the agent's Machine when a wake is pending and the agent is not
   * serving. The row update is the fence: one instance per 20 seconds.
   */
  async #budgetPaused(agentId: string): Promise<boolean> {
    if (!await freeAgentBudgetReached(this.database, (this.config.limits ?? DEFAULT_FREE_AGENT_LIMITS).dailyBudgetUsd)) return false;
    await recordFreeAgentEvent(this.database, agentId, 'budget_reached');
    return true;
  }

  async wake(agentId: string, cause: WakeCause = 'command'): Promise<boolean> {
    if (await this.#budgetPaused(agentId)) return false;
    const decision = await this.database.transaction(async (db) => {
      // The row lock is the fence: one instance decides each start or stop.
      await db.query(`SELECT 1 FROM free_agents WHERE agent_id=$1 FOR UPDATE`, [agentId]);
      const due = (
        await db.query<{ fly_machine_id: string; previous: string }>(
          `SELECT f.fly_machine_id,f.state previous FROM free_agents f WHERE f.agent_id=$1 AND ${WAKE_DUE_SQL}`,
          [agentId],
        )
      ).rows[0];
      if (!due) return undefined;
      const limit = (
        await db.query<{ stopped: boolean; starts: number }>(START_LIMIT_SQL, [
          agentId,
          FREE_AGENT_START_WINDOW_MINUTES,
        ])
      ).rows[0]!;
      if (limit.stopped) return undefined;
      if (limit.starts >= FREE_AGENT_START_LIMIT) {
        await this.#stopStarts(db, agentId, due.fly_machine_id, limit.starts);
        return { kind: 'stopped' as const, machineId: due.fly_machine_id, starts: limit.starts };
      }
      await db.query(
        `UPDATE free_agents SET state='waking',wake_requested_at=clock_timestamp(),
           last_activity_at=now(),updated_at=now() WHERE agent_id=$1`,
        [agentId],
      );
      await recordFreeAgentEvent(db, agentId, 'wake_requested', { cause, previous: due.previous });
      return { kind: 'claimed' as const, claimed: due };
    });
    if (!decision) return false;
    if (decision.kind === 'stopped') {
      this.log(`agent ${agentId.slice(0, 12)} never connected after ${decision.starts} starts; stopped starting`);
      captureServerError(
        new Error(`Free agent Machine never connected after ${decision.starts} starts in ${FREE_AGENT_START_WINDOW_MINUTES} minutes`),
        { area: 'free-agent-start-limit', agentId, machineId: decision.machineId, starts: String(decision.starts) },
      );
      await this.machines.stop(decision.machineId).catch((error) =>
        this.log(`stop ${agentId.slice(0, 12)}: ${String(error)}`),
      );
      return false;
    }
    const claimed = decision.claimed;
    try {
      await this.machines.start(claimed.fly_machine_id, this.config.image);
      await recordFreeAgentEvent(this.database, agentId, 'machine_started', {
        machineId: claimed.fly_machine_id,
      });
    } catch (error) {
      const state = await this.machines.state(claimed.fly_machine_id).catch(() => 'unknown');
      if (state === undefined) {
        // The Machine is gone (deleted by hand or by Fly). Recreate it.
        await this.database.query(
          `UPDATE free_agents SET fly_machine_id=NULL,state='destroyed',provision_attempts=0,
             provision_started_at=NULL,updated_at=now() WHERE agent_id=$1 AND removed_at IS NULL`,
          [agentId],
        );
        return this.provision(agentId);
      }
      // `started` already, or mid-transition: the sweep retries after the fence.
      if (state !== 'started' || (error instanceof FlyApiError && error.operation !== 'start')) throw error;
    }
    return true;
  }

  /**
   * Record the stop and tell the person whose message is waiting, in the Room
   * of the newest pending command. The notice id follows the stop event, so a
   * retry writes nothing twice.
   */
  async #stopStarts(db: SqlDatabase, agentId: string, machineId: string, starts: number): Promise<void> {
    await db.query(`UPDATE free_agents SET state='stopped',updated_at=now() WHERE agent_id=$1`, [agentId]);
    const event = (
      await db.query<{ id: string }>(
        `INSERT INTO free_agent_events(agent_id,kind,detail) VALUES($1,'start_limit_reached',$2::jsonb) RETURNING id`,
        [agentId, JSON.stringify({ machineId, starts })],
      )
    ).rows[0]!;
    const target = (
      await db.query<{ room_id: string; agent_name: string; person_id: string | null; person_handle: string | null }>(
        `SELECT command.room_id,agent.name agent_name,person.id person_id,person.handle person_handle
         FROM agent_commands command
         JOIN identities agent ON agent.id=command.agent_id
         JOIN free_agents f ON f.agent_id=command.agent_id
         LEFT JOIN messages source ON source.id=command.source_message_id
         LEFT JOIN identities author ON author.id=source.author_id AND author.kind='human'
         LEFT JOIN identities person ON person.id=COALESCE(author.id,f.owner_id)
         WHERE command.agent_id=$1 AND command.state='pending'
         ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
        [agentId],
      )
    ).rows[0];
    if (!target) return;
    await systemLine(db, {
      roomId: target.room_id,
      id: createHash('sha256').update(`free-agent-start-limit:${event.id}`).digest('hex'),
      subject: { kind: 'agent', id: agentId, name: target.agent_name },
      verb: systemMessage("free-agents.could-not-start"),
      ...(target.person_id && target.person_handle
        ? { object: { text: systemMessage("free-agents.for", target.person_handle), id: target.person_id } }
        : {}),
      consequence: systemMessage("free-agents.the-beeline-team-has-been-told-send-a-new-message-to-try-again"),
    });
  }

  /**
   * The helper reports a minute without work. Refuse while a wake is pending;
   * otherwise refresh an outdated Machine or suspend its ready helper.
   */
  async requestSleep(agentId: string, options: { refresh?: boolean } = {}): Promise<{ sleep: boolean }> {
    const slept = (
      await this.database.query<{ fly_machine_id: string }>(
        `UPDATE free_agents f SET state='sleeping',updated_at=now()
         WHERE f.agent_id=$1 AND f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL AND f.state IN ('running','waking')
           AND NOT ${connectorWorkSql('f.agent_id')}
           AND NOT EXISTS (SELECT 1 FROM agent_commands command
             WHERE command.agent_id=f.agent_id AND command.state IN ('pending','claimed'))
         RETURNING f.fly_machine_id`,
        [agentId],
      )
    ).rows[0];
    if (!slept) return { sleep: false };
    const mode = options.refresh ? 'refresh' : 'suspend';
    await recordFreeAgentEvent(this.database, agentId, 'sleep_requested', { mode });
    void this.#sleepMachine(agentId, slept.fly_machine_id, mode);
    return { sleep: true };
  }

  /** Image promotion warms existing sleepers without queuing an agent turn. */
  async refreshSleepingMachines(): Promise<void> {
    const sleepers = await this.database.query<{ agent_id: string; fly_machine_id: string }>(
      `SELECT agent_id,fly_machine_id FROM free_agents
       WHERE removed_at IS NULL AND fly_machine_id IS NOT NULL AND state='sleeping'`,
    );
    const results = await Promise.allSettled(sleepers.rows.map(async row => {
      if (await this.machines.refresh(row.fly_machine_id, this.config.image)) {
        await recordFreeAgentEvent(this.database, row.agent_id, 'refresh_started', {
          machineId: row.fly_machine_id, image: this.config.image,
        });
      }
    }));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason),
      `Free-agent image refresh failed: ${failures.map(result => String(result.reason)).join('; ')}`);
  }

  async #sleepMachine(agentId: string, machineId: string, mode: 'suspend' | 'refresh'): Promise<void> {
    // Let the helper's response leave the Machine before it freezes.
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      if (await this.machines.refresh(machineId, this.config.image, mode === 'refresh')) {
        // The new boot connects and uses this same idle-sleep path once the
        // installer and helper are ready. Never snapshot a half-booted helper.
        await recordFreeAgentEvent(this.database, agentId, 'refresh_started', { machineId, image: this.config.image });
        return;
      }
      await this.machines.suspend(machineId);
      // A suspend takes seconds to snapshot memory; `slept` marks the Machine
      // actually asleep, not the request.
      await this.machines.waitFor(machineId, 'suspended', 60);
      await recordFreeAgentEvent(this.database, agentId, 'slept', { machineId, state: 'suspended' });
    } catch (error) {
      this.log(`agent ${agentId.slice(0, 12)} sleep failed: ${String(error)}`);
    }
    // A wake that arrived while Fly was suspending would otherwise wait for the sweep.
    this.kick(agentId, 'sweep');
  }

  /**
   * First boot of a Machine: hand it everything it needs to stage its helper.
   * Valid until the agent first connects; each call mints a fresh daemon
   * exchange and model token, so a crashed first boot can simply retry.
   */
  async bootstrap(token: string): Promise<FreeAgentBootstrapGrant | undefined> {
    return this.database.transaction(async (database) => {
      const row = (
        await database.query<{
          agent_id: string;
          owner_id: string;
          workspace_id: string;
          workspace_name: string;
          sealed_keys: string;
          name: string;
          soul: { instructions?: string } | null;
          model: string | null;
        }>(
          `SELECT f.agent_id,f.owner_id,f.workspace_id,w.name workspace_name,f.sealed_keys,
                  i.name,a.soul,f.model
           FROM free_agents f JOIN workspaces w ON w.id=f.workspace_id
           JOIN identities i ON i.id=f.agent_id JOIN agents a ON a.agent_id=f.agent_id
           WHERE f.bootstrap_hash=$1 AND f.removed_at IS NULL AND f.state NOT IN ('failed','destroyed')
           FOR UPDATE OF f`,
          [tokenHash(token)],
        )
      ).rows[0];
      if (!row) return undefined;
      const keys = openSecrets<{ agent: string; body: string }>(this.config.sealSecret, row.sealed_keys);
      const modelToken = opaque('bfm');
      await database.query(
        `UPDATE free_agents SET model_token_hash=$2,updated_at=now() WHERE agent_id=$1`,
        [row.agent_id, tokenHash(modelToken)],
      );
      const exchange = await this.createDaemonExchange(row.agent_id, database);
      await recordFreeAgentEvent(database, row.agent_id, 'bootstrapped');
      return {
        agentId: row.agent_id,
        agentSecretKey: keys.agent,
        bodySecretKey: keys.body,
        agentName: row.name,
        harness: FREE_AGENT_HARNESS,
        model: freeAgentHarnessModel({ model: row.model ?? this.config.model }),
        soul: row.soul?.instructions ?? '',
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        pairedBy: row.owner_id,
        monolithBaseUrl: new URL(this.config.publicOrigin).origin,
        daemonExchangeToken: exchange.exchangeToken,
        modelToken,
        modelBaseUrl: `${new URL(this.config.publicOrigin).origin}/v1/free-agents/model`,
        upstreamModel: row.model ?? this.config.model,
        maxTurnSeconds: (this.config.limits ?? DEFAULT_FREE_AGENT_LIMITS).maxTurnMs / 1000,
        idleSeconds: this.config.idleSeconds,
      };
    });
  }

  /**
   * Leader sweep: retry provisioning, start agents with an overdue wake, put
   * forgotten running Machines to sleep, and delete Machines idle for the
   * retention window. Returns how many agents it acted on.
   */
  async nextDelayMs(admittedAt?:string): Promise<number | undefined> {
    return (await import('./background-deadline-clock.js')).backgroundNextDelay(this.database,
      `SELECT GREATEST(f.last_activity_at,COALESCE(f.wake_requested_at,f.created_at),
         (SELECT max(completed_at) FROM agent_commands WHERE agent_id=f.agent_id))
         +make_interval(secs=>${Math.min(this.config.reapIdleMs,this.config.idleSeconds*1000) / 1000}) due_at
       FROM free_agents f WHERE f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL AND f.state IN ('running','waking')
         AND NOT ${connectorWorkSql('f.agent_id')}
         AND NOT EXISTS(SELECT 1 FROM agent_commands WHERE agent_id=f.agent_id AND state IN ('pending','claimed'))
       UNION ALL SELECT GREATEST(f.last_activity_at,(SELECT max(created_at) FROM agent_commands WHERE agent_id=f.agent_id))
         +make_interval(secs=>${this.config.deleteAfterMs / 1000}) FROM free_agents f
         WHERE f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL AND f.state IN ('sleeping','stopped')
           AND NOT ${connectorWorkSql('f.agent_id')}
           AND NOT EXISTS(SELECT 1 FROM agent_commands WHERE agent_id=f.agent_id AND state IN ('pending','claimed'))
       UNION ALL SELECT provision_started_at+interval '2 minutes' FROM free_agents
         WHERE provision_started_at IS NOT NULL AND provision_error IS NULL AND removal_cleaned_at IS NULL`,admittedAt);
  }

  async sweep(): Promise<number> {
    let acted = 0;
    const removed = await this.database.query<{ agent_id: string }>(
      `SELECT agent_id FROM free_agents WHERE removed_at IS NOT NULL AND removal_cleaned_at IS NULL
       ORDER BY removed_at LIMIT 20`,
    );
    for (const row of removed.rows) {
      acted++;
      await this.cleanupRemoved(row.agent_id).catch(error =>
        this.log(`remove ${row.agent_id.slice(0, 12)}: ${String(error)}`),
      );
    }
    const provision = await this.database.query<{ agent_id: string }>(
      `SELECT agent_id FROM free_agents
       WHERE removed_at IS NULL AND fly_machine_id IS NULL AND state='provisioning' AND provision_attempts<5
         AND (${connectorWorkSql('free_agents.agent_id')} OR EXISTS (SELECT 1 FROM agent_commands command WHERE command.agent_id=free_agents.agent_id
           AND command.state='pending' ))
         AND (provision_started_at IS NULL OR provision_started_at<clock_timestamp()-interval '2 minutes')
       ORDER BY created_at LIMIT 20`,
    );
    for (const row of provision.rows) {
      acted++;
      await this.provision(row.agent_id).catch((error) =>
        this.log(`provision ${row.agent_id.slice(0, 12)}: ${String(error)}`),
      );
    }
    const wakes = await this.database.query<{ agent_id: string }>(
      `SELECT f.agent_id FROM free_agents f
       WHERE (f.fly_machine_id IS NOT NULL OR f.state='destroyed') AND f.state<>'failed' AND f.removed_at IS NULL
         AND (${connectorWorkSql('f.agent_id')} OR EXISTS (SELECT 1 FROM agent_commands command
           WHERE command.agent_id=f.agent_id AND command.state='pending'))
         AND NOT EXISTS (SELECT 1 FROM agent_connections connection
           JOIN live_server_instances server ON server.instance_id=connection.instance_id
           WHERE connection.agent_id=f.agent_id AND connection.released_at IS NULL
             AND server.renewed_at>clock_timestamp()-interval '90 seconds'
             AND f.state='running')
       LIMIT 50`,
    );
    for (const row of wakes.rows) {
      acted++;
      await this.#advance(row.agent_id, 'sweep').catch((error) =>
        this.log(`wake ${row.agent_id.slice(0, 12)}: ${String(error)}`),
      );
    }
    const idle = await this.database.query<{ agent_id: string; fly_machine_id: string }>(
      `UPDATE free_agents f SET state='sleeping',updated_at=now()
       WHERE f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL AND f.state IN ('running','waking')
         AND f.last_activity_at<clock_timestamp()-make_interval(secs => $1::double precision / 1000)
         AND COALESCE(f.wake_requested_at,f.created_at)<clock_timestamp()-make_interval(secs => $1::double precision / 1000)
         AND NOT ${connectorWorkSql('f.agent_id')}
         AND NOT EXISTS (SELECT 1 FROM agent_commands command
           WHERE command.agent_id=f.agent_id AND (command.state IN ('pending','claimed')
             OR (command.cancellation_reason IS DISTINCT FROM 'free-agent-time-limit'
               AND command.completed_at>clock_timestamp()-make_interval(secs => $1::double precision / 1000))))
       RETURNING f.agent_id,f.fly_machine_id`,
      [Math.min(this.config.reapIdleMs,this.config.idleSeconds*1000)],
    );
    for (const row of idle.rows) {
      acted++;
      await recordFreeAgentEvent(this.database, row.agent_id, 'reaped_idle');
      await this.#sleepMachine(row.agent_id,row.fly_machine_id,'suspend');
    }
    const expired = await this.database.query<{ agent_id: string; fly_machine_id: string }>(
      `SELECT f.agent_id,f.fly_machine_id FROM free_agents f
       WHERE f.removed_at IS NULL AND f.fly_machine_id IS NOT NULL AND f.state IN ('sleeping','stopped')
         AND f.last_activity_at<clock_timestamp()-make_interval(secs => $1::double precision / 1000)
         AND NOT ${connectorWorkSql('f.agent_id')}
         AND NOT EXISTS (SELECT 1 FROM agent_commands command
           WHERE command.agent_id=f.agent_id
             AND (command.state IN ('pending','claimed')
               OR command.created_at>clock_timestamp()-make_interval(secs => $1::double precision / 1000)))
       LIMIT 20`,
      [this.config.deleteAfterMs],
    );
    for (const row of expired.rows) {
      acted++;
      try {
        await this.machines.destroy(row.fly_machine_id);
        await this.database.query(
          `UPDATE free_agents SET fly_machine_id=NULL,state='destroyed',bootstrap_hash=NULL,
             provision_attempts=0,provision_started_at=NULL,updated_at=now()
           WHERE agent_id=$1 AND fly_machine_id=$2 AND removed_at IS NULL`,
          [row.agent_id, row.fly_machine_id],
        );
        await recordFreeAgentEvent(this.database, row.agent_id, 'deleted_idle', {
          machineId: row.fly_machine_id,
        });
      } catch (error) {
        this.log(`delete ${row.agent_id.slice(0, 12)}: ${String(error)}`);
      }
    }
    return acted;
  }

  /** Called only after removal commits; Fly failure cannot fail the Members action. */
  remove(agentId: string): void {
    void this.cleanupRemoved(agentId).catch(error =>
      this.log(`remove ${agentId.slice(0, 12)}: ${String(error)}`),
    );
  }

  /** Delete a retired agent's Machine; a failed call leaves durable work for the leader. */
  async cleanupRemoved(agentId: string): Promise<boolean> {
    const row = (await this.database.query<{ fly_machine_id: string | null; removal_cleaned_at: Date | null }>(
      `SELECT fly_machine_id,removal_cleaned_at FROM free_agents WHERE agent_id=$1 AND removed_at IS NOT NULL`,
      [agentId],
    )).rows[0];
    if (!row) return false;
    if (row.removal_cleaned_at) return true;
    const machineId = row.fly_machine_id ?? (await this.machines.find(agentId))?.id;
    if (machineId) await this.machines.destroy(machineId);
    // A create already in flight can return after this delete. Keep cleanup pending
    // through its provision lease; its completion stores the new id and retries cleanup.
    await this.database.query(
      `UPDATE free_agents SET fly_machine_id=NULL,removal_cleaned_at=CASE
         WHEN provision_started_at IS NULL OR provision_started_at<clock_timestamp()-interval '2 minutes'
         THEN clock_timestamp() ELSE NULL END,updated_at=now()
       WHERE agent_id=$1 AND removed_at IS NOT NULL AND fly_machine_id IS NOT DISTINCT FROM $2`,
      [agentId, row.fly_machine_id],
    );
    return true;
  }

  /** Committed work wakes the Machine; the sweep recovers missed notifications. */
  subscribeToWakes(live: LiveHub): () => void {
    return live.subscribeAll((event) => {
      if (event.type !== 'invalidate' || !event.targetAgentId) return;
      if (event.reason === 'connector-assignment') this.kickIfFree(event.targetAgentId, 'connector');
      else if (event.reason === 'postgres:agent_commands' && event.operation === 'INSERT')
        this.kickIfFree(event.targetAgentId);
    });
  }

  /** Start the Machine if committed work targets a free agent. */
  kickIfFree(agentId: string, cause: WakeCause = 'command'): void {
    void this.database
      .query(`SELECT 1 FROM free_agents f WHERE agent_id=$1 AND state<>'failed' AND removed_at IS NULL
        ${cause === 'connector' ? `AND ${connectorWorkSql('f.agent_id')}` : ''}`, [agentId])
      .then((found) => {
        if (found.rowCount) this.kick(agentId, cause);
      })
      .catch((error) => this.log(`wake lookup ${agentId.slice(0, 12)}: ${String(error)}`));
  }
}
