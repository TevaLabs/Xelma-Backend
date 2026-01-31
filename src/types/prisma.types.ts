/**
 * Local enum definitions matching Prisma schema
 * These are used when Prisma client is not yet generated
 */

export enum GameMode {
  UP_DOWN = 'UP_DOWN',
  LEGENDS = 'LEGENDS',
}

export enum RoundStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  LOCKED = 'LOCKED',
  RESOLVED = 'RESOLVED',
  CANCELLED = 'CANCELLED',
}

export enum PredictionSide {
  UP = 'UP',
  DOWN = 'DOWN',
}

export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
  ORACLE = 'ORACLE',
}
