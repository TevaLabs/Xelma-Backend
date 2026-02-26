import * as StellarSdk from '@stellar/stellar-sdk';
import logger from '../utils/logger';

/**
 * Verify a signature against a challenge using Stellar wallet verification
 * This implements the SEP-style challenge-response pattern
 *
 * @param walletAddress The Stellar wallet address (public key)
 * @param challenge The challenge string that was signed
 * @param signature The signature in base64 format
 * @returns True if signature is valid, false otherwise
 */
export async function verifySignature(
  walletAddress: string,
  challenge: string,
  signature: string
): Promise<boolean> {
  try {
    // Validate wallet address format
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(walletAddress)) {
      logger.error('Invalid Stellar wallet address format');
      return false;
    }

    // Create a keypair from the public key
    const keypair = StellarSdk.Keypair.fromPublicKey(walletAddress);

    // Convert signature from base64 to Buffer
    const signatureBuffer = Buffer.from(signature, 'base64');

    // Convert challenge to buffer
    const challengeBuffer = Buffer.from(challenge, 'utf8');

    // Verify the signature
    const isValid = keypair.verify(challengeBuffer, signatureBuffer);

    return isValid;
  } catch (error) {
    logger.error('Error verifying signature:', { error });
    return false;
  }
}

/**
 * Validate if a string is a valid Stellar public key
 * @param address Address to validate
 * @returns True if valid, false otherwise
 */
export function isValidStellarAddress(address: string): boolean {
  try {
    return StellarSdk.StrKey.isValidEd25519PublicKey(address);
  } catch (error) {
    return false;
  }
}

/**
 * Get account information from Stellar network (optional utility)
 * @param publicKey Stellar public key
 * @returns Account info or null if not found
 */
export async function getAccountInfo(publicKey: string): Promise<any | null> {
  try {
    const server = new StellarSdk.Horizon.Server(
      process.env.STELLAR_NETWORK === 'mainnet'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org'
    );

    const account = await server.loadAccount(publicKey);
    return account;
  } catch (error) {
    logger.error('Error fetching account info:', { error });
    return null;
  }
}
