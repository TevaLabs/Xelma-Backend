import { randomUUID } from "crypto";

/**
 * A Prisma-shaped, fully in-memory data store used when `DATA_STORE=memory`
 * (the DB-less hackathon demo mode). It supports the subset of the Prisma
 * Client API that hackathon-mounted routes actually call — see prisma.ts for
 * how this is wired in.
 *
 * This is NOT a general-purpose Prisma emulator: it implements exactly the
 * where/update/select/orderBy/cursor shapes used elsewhere in this codebase.
 * An operation this store doesn't understand throws a {@link MemoryDataStoreError}
 * instead of failing silently or crashing with an opaque TypeError, so gaps
 * surface immediately during development rather than as a random 500 later.
 */
export class MemoryDataStoreError extends Error {
  constructor(message: string) {
    super(`[memory data store] ${message}`);
    this.name = "MemoryDataStoreError";
  }
}

// ---------------------------------------------------------------------------
// Query engine — where / update / select / orderBy / pagination
// ---------------------------------------------------------------------------

const WHERE_OPERATORS = [
  "equals",
  "not",
  "in",
  "notIn",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "startsWith",
  "endsWith",
];

function toComparable(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as any).getTime() === new Date(b as any).getTime();
  }
  if (
    typeof a === "object" &&
    a !== null &&
    "equals" in a &&
    typeof (a as any).equals === "function"
  ) {
    return (a as any).equals(b);
  }
  return a === b;
}

function matchOperator(value: unknown, op: string, opValue: unknown): boolean {
  switch (op) {
    case "equals":
      return valuesEqual(value, opValue);
    case "not":
      return !valuesEqual(value, opValue);
    case "in":
      return (opValue as unknown[]).some((v) => valuesEqual(value, v));
    case "notIn":
      return !(opValue as unknown[]).some((v) => valuesEqual(value, v));
    case "gt":
      return toComparable(value) > toComparable(opValue);
    case "gte":
      return toComparable(value) >= toComparable(opValue);
    case "lt":
      return toComparable(value) < toComparable(opValue);
    case "lte":
      return toComparable(value) <= toComparable(opValue);
    case "contains":
      return typeof value === "string" && value.includes(String(opValue));
    case "startsWith":
      return typeof value === "string" && value.startsWith(String(opValue));
    case "endsWith":
      return typeof value === "string" && value.endsWith(String(opValue));
    default:
      throw new MemoryDataStoreError(`unsupported where operator "${op}"`);
  }
}

function matchField(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (
    condition === null ||
    condition instanceof Date ||
    typeof condition !== "object"
  ) {
    return valuesEqual(value, condition);
  }
  return Object.entries(condition as Record<string, unknown>).every(
    ([op, opValue]) => matchOperator(value, op, opValue),
  );
}

/**
 * Prisma represents a compound-unique lookup (e.g. `{ roundId_userId: { roundId, userId } }`)
 * as a synthetic key wrapping the real field names. Since the synthetic key name isn't
 * meaningful to this store, flatten it into its constituent fields.
 */
function normalizeWhere(
  where: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!where) return {};
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === "AND" || key === "OR" || key === "NOT") {
      flat[key] = value;
      continue;
    }
    if (
      value &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      !Array.isArray(value)
    ) {
      const isOperatorObject = Object.keys(value).some((k) =>
        WHERE_OPERATORS.includes(k),
      );
      if (!isOperatorObject) {
        Object.assign(flat, value as Record<string, unknown>);
        continue;
      }
    }
    flat[key] = value;
  }
  return flat;
}

function matchWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown> | undefined,
): boolean {
  const flat = normalizeWhere(where);
  return Object.entries(flat).every(([key, condition]) => {
    if (key === "AND") {
      return (condition as Record<string, unknown>[]).every((w) =>
        matchWhere(row, w),
      );
    }
    if (key === "OR") {
      return (condition as Record<string, unknown>[]).some((w) =>
        matchWhere(row, w),
      );
    }
    if (key === "NOT") {
      return !matchWhere(row, condition as Record<string, unknown>);
    }
    return matchField(row[key], condition);
  });
}

function applyUpdateData(
  row: Record<string, unknown>,
  data: Record<string, unknown>,
  touchUpdatedAt: boolean,
): Record<string, unknown> {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (
      value &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      !Array.isArray(value) &&
      ("increment" in value ||
        "decrement" in value ||
        "set" in value ||
        "multiply" in value ||
        "divide" in value)
    ) {
      const op = value as Record<string, unknown>;
      const current = toComparable(next[key] ?? 0);
      if ("increment" in op) next[key] = current + toComparable(op.increment);
      else if ("decrement" in op) next[key] = current - toComparable(op.decrement);
      else if ("multiply" in op) next[key] = current * toComparable(op.multiply);
      else if ("divide" in op) next[key] = current / toComparable(op.divide);
      else next[key] = op.set;
    } else {
      next[key] = value;
    }
  }
  if (touchUpdatedAt && "updatedAt" in row) {
    next.updatedAt = new Date();
  }
  return next;
}

function applySelect(
  row: Record<string, unknown>,
  select: Record<string, boolean> | undefined,
): Record<string, unknown> {
  if (!select) return row;
  const projected: Record<string, unknown> = {};
  for (const [key, include] of Object.entries(select)) {
    if (include) projected[key] = row[key];
  }
  return projected;
}

type OrderBySpec =
  | Record<string, "asc" | "desc">
  | Record<string, "asc" | "desc">[]
  | undefined;

function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  orderBy: OrderBySpec,
): T[] {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, direction] of Object.entries(spec)) {
        const cmp = toComparable(a[field]) - toComparable(b[field]);
        if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
      }
    }
    return 0;
  });
}

interface QueryArgs {
  where?: Record<string, unknown>;
  select?: Record<string, boolean>;
  orderBy?: OrderBySpec;
  take?: number;
  skip?: number;
  cursor?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Generic collection
// ---------------------------------------------------------------------------

export class MemoryCollection<T extends Record<string, unknown>> {
  private readonly rows: Map<string, T> = new Map();

  constructor(
    private readonly idField: string = "id",
    private readonly defaults: () => Partial<T> = () => ({}) as Partial<T>,
    private readonly generateId: () => string | number = randomUUID,
  ) {}

  /** Pre-populates fixture rows, e.g. the hackathon mock-data seed. Bypasses defaults. */
  seed(rows: T[]): this {
    for (const row of rows) {
      this.rows.set(String(row[this.idField]), row);
    }
    return this;
  }

  private materialize(row: T): T {
    return { ...row };
  }

  private filtered(where?: Record<string, unknown>): T[] {
    return Array.from(this.rows.values()).filter((row) =>
      matchWhere(row, where),
    );
  }

  async create({ data }: { data: Partial<T> }): Promise<T> {
    const id =
      (data as Record<string, unknown>)[this.idField] ?? this.generateId();
    const now = new Date();
    const row = {
      ...this.defaults(),
      createdAt: now,
      updatedAt: now,
      ...data,
      [this.idField]: id,
    } as unknown as T;
    this.rows.set(String(id), row);
    return this.materialize(row);
  }

  async findUnique({
    where,
    select,
  }: QueryArgs): Promise<T | null> {
    const match = this.filtered(where)[0] ?? null;
    if (!match) return null;
    return applySelect(this.materialize(match), select) as T;
  }

  async findFirst({ where, orderBy, select }: QueryArgs): Promise<T | null> {
    const rows = sortRows(this.filtered(where), orderBy);
    const match = rows[0] ?? null;
    if (!match) return null;
    return applySelect(this.materialize(match), select) as T;
  }

  async findMany({
    where,
    orderBy,
    take,
    skip = 0,
    cursor,
    select,
  }: QueryArgs = {}): Promise<T[]> {
    let rows = sortRows(this.filtered(where), orderBy);

    let start = skip;
    if (cursor) {
      const cursorFlat = normalizeWhere(cursor);
      const idx = rows.findIndex((row) =>
        Object.entries(cursorFlat).every(([k, v]) => valuesEqual(row[k], v)),
      );
      start = idx === -1 ? rows.length : idx + skip;
    }

    rows = rows.slice(start, take !== undefined ? start + take : undefined);
    return rows.map((row) => applySelect(this.materialize(row), select) as T);
  }

  async update({
    where,
    data,
  }: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<T> {
    const existing = this.filtered(where)[0];
    if (!existing) {
      throw new MemoryDataStoreError(
        `record not found for update (where=${JSON.stringify(where)})`,
      );
    }
    const updated = applyUpdateData(existing, data, true) as T;
    this.rows.set(String(updated[this.idField]), updated);
    return this.materialize(updated);
  }

  async updateMany({
    where,
    data,
  }: {
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }> {
    const matches = this.filtered(where);
    for (const row of matches) {
      const updated = applyUpdateData(row, data, true) as T;
      this.rows.set(String(updated[this.idField]), updated);
    }
    return { count: matches.length };
  }

  async upsert({
    where,
    create,
    update,
  }: {
    where: Record<string, unknown>;
    create: Partial<T>;
    update: Record<string, unknown>;
  }): Promise<T> {
    const existing = this.filtered(where)[0];
    if (existing) {
      const updated = applyUpdateData(existing, update, true) as T;
      this.rows.set(String(updated[this.idField]), updated);
      return this.materialize(updated);
    }
    return this.create({ data: create });
  }

  async delete({ where }: { where: Record<string, unknown> }): Promise<T> {
    const existing = this.filtered(where)[0];
    if (!existing) {
      throw new MemoryDataStoreError(
        `record not found for delete (where=${JSON.stringify(where)})`,
      );
    }
    this.rows.delete(String(existing[this.idField]));
    return this.materialize(existing);
  }

  async deleteMany({
    where,
  }: { where?: Record<string, unknown> } = {}): Promise<{ count: number }> {
    const matches = this.filtered(where);
    for (const row of matches) {
      this.rows.delete(String(row[this.idField]));
    }
    return { count: matches.length };
  }

  async count({
    where,
  }: { where?: Record<string, unknown> } = {}): Promise<number> {
    return this.filtered(where).length;
  }

  /** Scoped to the one groupBy shape used in this codebase: group by a single field, `_count`. */
  async groupBy({
    by,
    _count,
  }: {
    by: string[];
    _count: Record<string, boolean>;
  }): Promise<Record<string, unknown>[]> {
    if (by.length !== 1) {
      throw new MemoryDataStoreError(
        "groupBy is only supported for a single field in memory mode",
      );
    }
    const [field] = by;
    const countField = Object.keys(_count)[0];
    const groups = new Map<unknown, number>();
    for (const row of this.rows.values()) {
      const key = row[field];
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return Array.from(groups.entries()).map(([key, count]) => ({
      [field]: key,
      _count: { [countField]: count },
    }));
  }

  /** Direct read access for cross-collection relation resolution (e.g. `include`). */
  peek(id: string): T | undefined {
    const row = this.rows.get(id);
    return row ? this.materialize(row) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Model collections
// ---------------------------------------------------------------------------

const DEFAULT_NOTIFICATION_PREFS = {
  win: true,
  loss: true,
  roundStart: false,
  bonus: true,
  announcement: true,
};

const users = new MemoryCollection("id", () => ({
  publicKey: null,
  nickname: null,
  avatarUrl: null,
  preferences: null,
  virtualBalance: 1000,
  wins: 0,
  streak: 0,
  role: "USER",
  notificationPreferences: DEFAULT_NOTIFICATION_PREFS,
  lastLoginAt: null,
}));
const authChallenges = new MemoryCollection("id", () => ({
  userId: null,
  usedAt: null,
  isUsed: false,
}));
const transactions = new MemoryCollection("id", () => ({
  description: null,
  roundId: null,
}));
const rounds = new MemoryCollection("id", () => ({
  status: "PENDING",
  endPrice: null,
  sorobanRoundId: null,
  isSoroban: false,
  poolUp: 0,
  poolDown: 0,
  priceRanges: null,
  resolvedAt: null,
}));
const predictions = new MemoryCollection("id", () => ({
  side: null,
  priceRange: null,
  won: null,
  payout: null,
}));
const bets = new MemoryCollection("id", () => ({
  roundId: null,
  side: null,
  predictedPrice: null,
  status: "ACCEPTED",
  txHash: null,
  failureReason: null,
  submittedAt: null,
  confirmedAt: null,
  resolvedAt: null,
  failedAt: null,
}));
const notifications = new MemoryCollection("id", () => ({
  data: null,
  isRead: false,
}));
const userStats = new MemoryCollection("id", () => ({
  totalPredictions: 0,
  correctPredictions: 0,
  totalEarnings: 0,
  upDownWins: 0,
  upDownLosses: 0,
  upDownEarnings: 0,
  legendsWins: 0,
  legendsLosses: 0,
  legendsEarnings: 0,
}));
const messages = new MemoryCollection("id", () => ({}));
const tournaments = new MemoryCollection("id", () => ({
  status: "UPCOMING",
  currentParticipants: 0,
  rounds: 1,
}));
const tournamentParticipants = new MemoryCollection("id", () => ({}));
const multiplayerSessions = new MemoryCollection("id", () => ({
  rooms: [],
  metadata: null,
  disconnectedAt: null,
  lastSeenAt: new Date(),
}));
const auditLogs = new MemoryCollection("id");
const outboxEvents = new MemoryCollection("id", () => ({
  status: "PENDING",
  attempts: 0,
  lastError: null,
  processedAt: null,
}));

// ---------------------------------------------------------------------------
// Hackathon mock-data fixtures (mockRound / mockLeaderboard / mockBet /
// mockPlatformStat) — these back the "mock" tier of round.service's
// Soroban → database → mock fallback, and must work standalone in memory
// mode without a seeded Postgres. Fixtures mirror scripts/seed-mock-data.ts
// so memory mode and a freshly-seeded database demo look the same.
// ---------------------------------------------------------------------------

const minutesFromNow = (minutes: number): string =>
  new Date(Date.now() + minutes * 60 * 1000).toISOString();

let mockBetAutoId = 1;
const mockBets = new MemoryCollection(
  "id",
  () => ({}),
  () => mockBetAutoId++,
);

const mockRounds = new MemoryCollection("id").seed([
  {
    id: "btc-updown-live",
    asset: "BTC",
    mode: "updown",
    status: "live",
    startPrice: 67420,
    poolUp: 2800,
    poolDown: 1400,
    totalPool: null,
    predictionCount: null,
    closesAt: minutesFromNow(3),
  },
  {
    id: "eth-precision-live",
    asset: "ETH",
    mode: "precision",
    status: "live",
    startPrice: 3241,
    poolUp: null,
    poolDown: null,
    totalPool: 1800,
    predictionCount: 22,
    closesAt: minutesFromNow(12),
  },
  {
    id: "xlm-updown-new",
    asset: "XLM",
    mode: "updown",
    status: "new",
    startPrice: 0.2891,
    poolUp: 200,
    poolDown: 0,
    totalPool: null,
    predictionCount: null,
    closesAt: minutesFromNow(20),
  },
] as Record<string, unknown>[]);

const mockLeaderboard = new MemoryCollection("address").seed([
  { rank: 1, address: "GBZX...9QRA", totalWins: 42, totalLosses: 8, winStreak: 9, xp: 18400, rankTitle: "Oracle", balance: 1000, pendingWinnings: 0 },
  { rank: 2, address: "GDK4...2LXM", totalWins: 37, totalLosses: 10, winStreak: 6, xp: 15950, rankTitle: "Market Sage", balance: 1000, pendingWinnings: 0 },
  { rank: 3, address: "GAV7...8PQN", totalWins: 35, totalLosses: 13, winStreak: 4, xp: 14820, rankTitle: "Trend Master", balance: 1000, pendingWinnings: 0 },
  { rank: 4, address: "GC9M...5VTE", totalWins: 31, totalLosses: 14, winStreak: 3, xp: 13210, rankTitle: "Signal Hunter", balance: 1000, pendingWinnings: 0 },
  { rank: 5, address: "GCB2...7KDW", totalWins: 29, totalLosses: 15, winStreak: 5, xp: 12490, rankTitle: "Pool Climber", balance: 1000, pendingWinnings: 0 },
  { rank: 6, address: "GDPT...4NLA", totalWins: 26, totalLosses: 16, winStreak: 2, xp: 11160, rankTitle: "Price Reader", balance: 1000, pendingWinnings: 0 },
  { rank: 7, address: "GB7N...6XHF", totalWins: 24, totalLosses: 18, winStreak: 1, xp: 10240, rankTitle: "Streak Keeper", balance: 1000, pendingWinnings: 0 },
  { rank: 8, address: "GCR8...3MLB", totalWins: 22, totalLosses: 20, winStreak: 2, xp: 9480, rankTitle: "Chart Scout", balance: 1000, pendingWinnings: 0 },
  { rank: 9, address: "GAF5...1ZQH", totalWins: 19, totalLosses: 17, winStreak: 1, xp: 8360, rankTitle: "Breakout Seeker", balance: 1000, pendingWinnings: 0 },
  { rank: 10, address: "GDT6...8RCV", totalWins: 17, totalLosses: 19, winStreak: 0, xp: 7540, rankTitle: "Rookie Prophet", balance: 1000, pendingWinnings: 0 },
] as Record<string, unknown>[]);

const mockPlatformStats = new MemoryCollection("id").seed([
  {
    id: 1,
    totalRounds: 1247,
    totalVxlmDistributed: 4200000,
    activePlayers: 893,
    totalBetsPlaced: 8432,
  },
] as Record<string, unknown>[]);

/** Attaches `user: { walletAddress }`-shaped includes used by chat routes. */
function withUserInclude<T extends Record<string, unknown>>(
  row: T,
  include: { user?: { select?: Record<string, boolean> } } | undefined,
): T {
  if (!include?.user) return row;
  const user = users.peek(String((row as Record<string, unknown>).userId));
  return {
    ...row,
    user: user ? applySelect(user, include.user.select) : null,
  };
}

/** Attaches `round: {...}`-shaped includes used by user history routes. */
function withRoundInclude<T extends Record<string, unknown>>(
  row: T,
  include: { round?: { select?: Record<string, boolean> } } | undefined,
): T {
  if (!include?.round) return row;
  const round = rounds.peek(String((row as Record<string, unknown>).roundId));
  return {
    ...row,
    round: round ? applySelect(round, include.round.select) : null,
  };
}

function messageModel() {
  return {
    create: async (args: { data: Record<string, unknown>; include?: any }) => {
      const row = await messages.create(args);
      return withUserInclude(row, args.include);
    },
    findMany: async (args: QueryArgs & { include?: any } = {}) => {
      const rows = await messages.findMany(args);
      return rows.map((row) => withUserInclude(row, args.include));
    },
    count: (args?: { where?: Record<string, unknown> }) => messages.count(args),
  };
}

function predictionModel() {
  return {
    findMany: async (args: QueryArgs & { include?: any } = {}) => {
      const rows = await predictions.findMany(args);
      return rows.map((row) => withRoundInclude(row, args.include));
    },
    findUnique: predictions.findUnique.bind(predictions),
    count: predictions.count.bind(predictions),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const modelClients = {
  user: users,
  authChallenge: authChallenges,
  transaction: transactions,
  round: rounds,
  prediction: predictionModel(),
  bet: bets,
  notification: notifications,
  userStats,
  message: messageModel(),
  tournament: tournaments,
  tournamentParticipant: tournamentParticipants,
  multiplayerSession: multiplayerSessions,
  auditLog: auditLogs,
  outboxEvent: outboxEvents,
  mockRound: mockRounds,
  mockLeaderboard,
  mockBet: mockBets,
  mockPlatformStat: mockPlatformStats,
};

/**
 * Creates a Prisma-shaped client entirely backed by in-memory collections.
 * Intended for `DATA_STORE=memory` boots (the DB-less hackathon demo mode) —
 * see src/lib/prisma.ts.
 */
export function createMemoryPrismaClient() {
  const client: Record<string, unknown> = {
    ...modelClients,
    $queryRaw: async () => [],
    $disconnect: async () => undefined,
    $connect: async () => undefined,
    $transaction: async (arg: unknown) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      if (typeof arg === "function") {
        return (arg as (tx: unknown) => Promise<unknown>)(client);
      }
      throw new MemoryDataStoreError(
        "$transaction expects an array of promises or a callback in memory mode",
      );
    },
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && !prop.startsWith("$")) {
        throw new MemoryDataStoreError(
          `model "${prop}" has no in-memory stub — add one in src/lib/memory-prisma.ts`,
        );
      }
      return undefined;
    },
  });
}
