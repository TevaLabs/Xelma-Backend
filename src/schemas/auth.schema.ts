import { z } from 'zod';
import { isValidStellarAddress } from '../services/stellar.service';

const walletAddressField = (requiredMsg: string) =>
  z.preprocess(
    (val) => (val === undefined || val === null ? '' : val),
    z
      .string()
      .min(1, requiredMsg)
      .refine(isValidStellarAddress, 'Invalid Stellar wallet address format'),
  );

const requiredStringField = (requiredMsg: string) =>
  z.preprocess(
    (val) => (val === undefined || val === null ? '' : val),
    z.string().min(1, requiredMsg),
  );

export const challengeSchema = z.object({
  walletAddress: walletAddressField('walletAddress is required'),
});

export const connectSchema = z.object({
  walletAddress: walletAddressField('walletAddress, challenge, and signature are required'),
  challenge: requiredStringField('walletAddress, challenge, and signature are required'),
  signature: requiredStringField('walletAddress, challenge, and signature are required'),
});
