import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactSvmSchemeV1 } from "@x402/svm/exact/v1/client";
import bs58 from "bs58";
import { debug } from "./logger.js";

/** v1 legacy network names used by the x402 SDK for scheme registration. */
const V1_NETWORKS = ["solana", "solana-devnet", "solana-testnet"];

/**
 * Build a fetch function that transparently handles x402 payment challenges.
 *
 * When the remote server responds with HTTP 402, this wrapper:
 * 1. Parses the payment requirements from the response
 * 2. Creates a signed Solana USDC payment payload via the x402 SDK
 * 3. Retries the original request with the X-PAYMENT header attached
 *
 * @param privateKeyBase58 - Base58-encoded 64-byte Solana keypair
 * @param rpcUrl - Optional custom Solana RPC URL (avoids public mainnet rate limits)
 */
export async function createX402Fetch(
  privateKeyBase58: string,
  rpcUrl?: string,
): Promise<typeof globalThis.fetch> {
  const keypairBytes = bs58.decode(privateKeyBase58);
  if (keypairBytes.length !== 64) {
    throw new Error(
      `Invalid Solana private key: expected 64 bytes after base58 decoding, got ${keypairBytes.length}. ` +
        "Ensure SOLANA_PRIVATE_KEY is a valid base58-encoded 64-byte keypair.",
    );
  }
  const signer = await createKeyPairSignerFromBytes(keypairBytes);

  // Register schemes manually (instead of registerExactSvmScheme) so we can
  // forward the user's custom RPC URL to avoid public mainnet rate limits.
  const svmConfig = rpcUrl ? { rpcUrl } : undefined;
  const coreClient = new x402Client();
  coreClient.register("solana:*", new ExactSvmScheme(signer, svmConfig));
  for (const network of V1_NETWORKS) {
    coreClient.registerV1(network, new ExactSvmSchemeV1(signer, svmConfig));
  }
  const httpClient = new x402HTTPClient(coreClient);

  if (rpcUrl) {
    debug(`x402 SDK using custom RPC: ${rpcUrl}`);
  }

  const wrappedFetch: typeof globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Clone Request inputs so the body can be re-sent on a 402 retry.
    // If input is a Request with a body, the first fetch consumes it.
    const retryInput = input instanceof Request ? input.clone() : input;
    const response = await globalThis.fetch(input, init);

    if (response.status !== 402) {
      return response;
    }

    debug("Received 402 — processing x402 payment");

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      debug("Failed to parse 402 response body as JSON");
      throw new Error(
        "x402 payment challenge response is not valid JSON — cannot process payment",
      );
    }

    debug(`x402 payment requirements body: ${JSON.stringify(body)}`);

    let paymentRequired;
    try {
      paymentRequired = httpClient.getPaymentRequiredResponse(
        (name: string) => response.headers.get(name),
        body,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug(`Failed to parse payment requirements: ${msg}`);
      throw new Error(`x402: failed to parse payment requirements — ${msg}`);
    }

    // Check if any registered hook can resolve without payment
    const hookHeaders = await httpClient.handlePaymentRequired(paymentRequired);
    const baseHeaders = {
      ...requestHeadersToRecord(input),
      ...headersToRecord(init?.headers),
    };
    if (hookHeaders) {
      debug("Hook provided headers, retrying without payment");
      const mergedInit = { ...init, headers: { ...baseHeaders, ...hookHeaders } };
      return globalThis.fetch(retryInput, mergedInit);
    }

    let paymentPayload;
    try {
      paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug(`x402 payment creation failed: ${msg}`);
      throw new Error(`x402: payment creation failed — ${msg}`);
    }
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    debug("Payment payload created, retrying with X-PAYMENT header");

    const retryInit: RequestInit = {
      ...init,
      headers: { ...baseHeaders, ...paymentHeaders },
    };

    return globalThis.fetch(retryInput, retryInit);
  };

  return wrappedFetch;
}

function requestHeadersToRecord(
  input: RequestInfo | URL,
): Record<string, string> {
  if (input instanceof Request) {
    return headersToRecord(input.headers);
  }
  return {};
}

function headersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers as Record<string, string>;
}
