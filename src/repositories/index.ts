import config from "../config";
import { createInMemoryRepositories } from "./in-memory.repositories";
import { createPrismaRepositories } from "./prisma.repositories";
import { Repositories } from "./interfaces";

let repositories: Repositories | null = null;

export function createRepositories(dataStore = config.app.dataStore): Repositories {
  return dataStore === "memory"
    ? createInMemoryRepositories()
    : createPrismaRepositories();
}

export function getRepositories(): Repositories {
  if (!repositories) {
    repositories = createRepositories();
  }
  return repositories;
}

export function setRepositoriesForTests(next: Repositories | null): void {
  repositories = next;
}

export type { Repositories, RoundRepository, LeaderboardRepository, StatsRepository } from "./interfaces";
