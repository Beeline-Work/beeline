/** Slots are per server machine. The listener holds a separate dedicated connection. */
export interface DatabaseConnectionBudget {
  readonly maxConnections: number;
  readonly reservedConnections: number;
  readonly serverMachines: number;
  readonly perMachine: number;
  readonly app: number;
  readonly enrichment: number;
  readonly diagnostics: number;
  readonly jobs: number;
  readonly listener: 1;
}

export function databaseConnectionBudget(
  maxConnections: number,
  serverMachines = 2,
  requestedAppConnections = 5,
): DatabaseConnectionBudget {
  for (const [name, value] of [
    ['max_connections', maxConnections],
    ['server machines', serverMachines],
    ['requested app connections', requestedAppConnections],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}: ${value}`);
  }
  // PostgreSQL's max_connections also includes administrative and migration
  // clients. Reserve at least six slots, including its superuser reserve.
  const reservedConnections = Math.max(6, Math.ceil(maxConnections / 5));
  const perMachine = Math.floor((maxConnections - reservedConnections) / serverMachines);
  // The leader holds one jobs connection while its work uses the other.
  // Reducing jobs below two would deadlock that work even when the DB is idle.
  if (perMachine < 6)
    throw new Error(
      `database capacity too small: max_connections=${maxConnections}, ${serverMachines} server machines need at least 6 connections each plus ${reservedConnections} reserved`,
    );
  const diagnostics = 1;
  const listener = 1;
  const jobs = 2;
  const enrichment = Math.min(2, Math.max(1, perMachine - diagnostics - listener - jobs - 1));
  const app = Math.min(requestedAppConnections, perMachine - diagnostics - listener - jobs - enrichment);
  return {
    maxConnections,
    reservedConnections,
    serverMachines,
    perMachine,
    app,
    enrichment,
    diagnostics,
    jobs,
    listener,
  };
}
