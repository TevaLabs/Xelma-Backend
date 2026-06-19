export interface WalletStats {
  address: string;
  balance: number;
  pendingWinnings: number;
  totalWins: number;
  totalLosses: number;
  currentStreak: number;
  xp: number;
  rankTitle: string;
}

export function getMockWalletStats(address: string): WalletStats {
  // TODO: Wire to contract get_user_stats() and get_pending_winnings()
  return {
    address,
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 3,
    totalLosses: 1,
    currentStreak: 3,
    xp: 410,
    rankTitle: "Rookie",
  };
}
