class SimulationService {
  async simulateRound(id: string, finalPrice: number): Promise<any> {
    return {
      success: true,
      roundId: id,
      finalPrice,
    };
  }
}

export default new SimulationService();
