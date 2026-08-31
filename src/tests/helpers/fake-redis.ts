/**
 * Minimal in-memory Redis stand-in covering exactly the commands the
 * distributed lock uses: `SET key value NX PX`, and `EVAL` of the renew and
 * release Lua scripts.
 *
 * Real TTL expiry is simulated on read, and tests get direct controls
 * ({@link FakeRedis.forceExpire}, {@link FakeRedis.steal}) so lock-loss paths
 * can be triggered deterministically instead of by waiting on a clock.
 */
export interface FakeRedisEntry {
   value: string;
   expiresAtMs: number;
}

export class FakeRedis {
   private readonly store = new Map<string, FakeRedisEntry>();

   /** Set to make the next command reject, simulating a Redis blip. */
   failNextCommand: Error | null = null;
   /** Set to make every command reject, simulating a full outage. */
   failAllCommands: Error | null = null;

   private checkFailure(): void {
      if (this.failAllCommands) {
         throw this.failAllCommands;
      }
      if (this.failNextCommand) {
         const error = this.failNextCommand;
         this.failNextCommand = null;
         throw error;
      }
   }

   private live(key: string): FakeRedisEntry | null {
      const entry = this.store.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs <= Date.now()) {
         this.store.delete(key);
         return null;
      }
      return entry;
   }

   async set(
      key: string,
      value: string,
      options?: { NX?: boolean; PX?: number; EX?: number }
   ): Promise<string | null> {
      this.checkFailure();

      if (options?.NX && this.live(key)) {
         return null;
      }

      const ttlMs = options?.PX ?? (options?.EX ?? 30) * 1000;
      this.store.set(key, { value, expiresAtMs: Date.now() + ttlMs });
      return 'OK';
   }

   async eval(
      script: string,
      options: { keys: string[]; arguments: string[] }
   ): Promise<number> {
      this.checkFailure();

      const key = options.keys[0];
      const owner = options.arguments[0];
      const entry = this.live(key);

      // Release script: delete only our own key.
      if (script.includes('del')) {
         if (entry?.value === owner) {
            this.store.delete(key);
            return 1;
         }
         return 0;
      }

      // Renew script: 1 = renewed, 0 = key gone, -1 = owned by someone else.
      if (!entry) return 0;
      if (entry.value !== owner) return -1;

      entry.expiresAtMs = Date.now() + Number(options.arguments[1]);
      return 1;
   }

   // --- test controls ---

   /** Current owner id of a key, or null when unset/expired. */
   ownerOf(key: string): string | null {
      return this.live(key)?.value ?? null;
   }

   /** Drop a key as if its TTL had lapsed. */
   forceExpire(key: string): void {
      this.store.delete(key);
   }

   /** Hand a key to a different owner, as a competing instance would. */
   steal(key: string, newOwner: string, ttlMs = 30_000): void {
      this.store.set(key, { value: newOwner, expiresAtMs: Date.now() + ttlMs });
   }

   /** Milliseconds until a key expires; -1 when it does not exist. */
   ttlMs(key: string): number {
      const entry = this.live(key);
      return entry ? entry.expiresAtMs - Date.now() : -1;
   }

   reset(): void {
      this.store.clear();
      this.failNextCommand = null;
      this.failAllCommands = null;
   }
}
