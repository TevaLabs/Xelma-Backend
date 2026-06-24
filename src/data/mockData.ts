// TODO: Replace with PostgreSQL database
export const mockData = {
  prices: [
    { id: 'bitcoin', symbol: 'btc', price: 60000 },
    { id: 'ethereum', symbol: 'eth', price: 3000 },
  ],
  // TODO: Replace with live Stellar RPC queries via @stellar/stellar-sdk
  platformStats: {
    totalRounds: 1247,
    totalVxlmDistributed: 4200000,
    activePlayers: 893,
    totalBetsPlaced: 8432,
  },
};