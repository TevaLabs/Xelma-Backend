import { z } from 'zod';
import { isValidStellarAddress } from '../services/stellar.service';

export const challengeSchema = z.object({
  walletAddress: z
    .string()
    .min(1, 'walletAddress is required')
    .refine(isValidStellarAddress, 'Invalid Stellar wallet address format'),
});

export const connectSchema = z.object({
  walletAddress: z
    .string()
    .min(1, 'walletAddress, challenge, and signature are required')
    .refine(isValidStellarAddress, 'Invalid Stellar wallet address format'),
  challenge: z
    .string()
    .min(1, 'walletAddress, challenge, and signature are required'),
  signature: z
    .string()
    .min(1, 'walletAddress, challenge, and signature are required'),
});
