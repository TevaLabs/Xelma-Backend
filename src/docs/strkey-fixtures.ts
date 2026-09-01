/**
 * Shared, cryptographically-valid Stellar StrKey fixtures.
 *
 * WHY FAKE BUT CRYPTOGRAPHICALLY VALID KEYS
 * -----------------------------------------
 * OpenAPI specification examples should let a consumer copy a value straight
 * into a request without tripping the server's wallet-format validation. A
 * random-looking string that merely *resembles* a Stellar address (e.g.
 * "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX") fails
 * `StrKey.decodeEd25519PublicKey` because its body does not decode to a valid
 * Ed25519 public key or a valid CRC16-XModem checksum. Posting it to
 * `/api/auth/challenge` therefore returns a 400, so the documentation example
 * "works" on first glance but breaks any integration test that copies it.
 *
 * By contrast, the fixtures below are produced by `Keypair.random()` from the
 * Stellar SDK, so each one is a genuine, well-formed `G...` Ed25519 public key
 * that passes the exact validation the runtime enforces. Using them keeps the
 * docs honest and copy-pasteable without requiring any active network node or
 * a real user wallet.
 *
 * These are deliberately *only* public keys. No secret seed accompanies them,
 * so nothing usable is committed — they serve purely as fixture examples, not
 * as signing material for any real account.
 */

/**
 * A valid `G...` Ed25519 public key used as the example wallet for the
 * `/api/auth/challenge` request body.
 *
 * @see `StrKey.decodeEd25519PublicKey` — this constant decodes without error.
 */
export const CHALLENGE_EXAMPLE_PUBLIC_KEY =
  'GB2IKI5ONW2CQBD7WX4I76B5V65KQNEEVBLFYSYPC4IMHENDNBR5AYUN';

/**
 * A valid `G...` Ed25519 public key used as the example wallet for the
 * `/api/auth/connect` request body. It is a different key from
 * `CHALLENGE_EXAMPLE_PUBLIC_KEY` so the connect example reads as a realistic
 * follow-up (challenge issued for one wallet, then that wallet connects).
 */
export const CONNECT_EXAMPLE_PUBLIC_KEY =
  'GDRHOLGIIVOGHNURCNVVGUXBUJCVTSKH2V7ACB4E4ZOR7KC3XGIBK5CT';