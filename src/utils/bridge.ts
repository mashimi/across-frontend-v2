import { clients } from "@uma/sdk";
import { ethers, BigNumber } from "ethers";

import { ChainId, referrerDelimiterHex } from "./constants";

import { tagAddress } from "./format";
import { getProvider } from "./providers";
import { getConfig } from "utils";
import getApiEndpoint from "./serverless-api";
import { BridgeLimitInterface } from "./serverless-api/types";

export type Fee = {
  total: ethers.BigNumber;
  pct: ethers.BigNumber;
};

export type BridgeFees = {
  relayerFee: Fee;
  lpFee: Fee;
  // Note: relayerGasFee and relayerCapitalFee are components of relayerFee.
  relayerGasFee: Fee;
  relayerCapitalFee: Fee;
  quoteTimestamp: ethers.BigNumber;
  quoteTimestampInMs: ethers.BigNumber;
  quoteLatency: ethers.BigNumber;
  quoteBlock: ethers.BigNumber;
};

type GetBridgeFeesArgs = {
  amount: ethers.BigNumber;
  tokenSymbol: string;
  blockTimestamp: number;
  fromChainId: ChainId;
  toChainId: ChainId;
};

export type GetBridgeFeesResult = BridgeFees & {
  isAmountTooLow: boolean;
};

/**
 *
 * @param amount - amount to bridge
 * @param tokenSymbol - symbol of the token to bridge
 * @param blockTimestamp - timestamp of the block to use for calculating fees on
 * @param fromChain The origin chain of this bridge action
 * @param toChain The destination chain of this bridge action
 * @returns Returns the `relayerFee` and `lpFee` fees for bridging the given amount of tokens, along with an `isAmountTooLow` flag indicating whether the amount is too low to bridge and an `isLiquidityInsufficient` flag indicating whether the liquidity is insufficient.
 */
export async function getBridgeFees({
  amount,
  tokenSymbol,
  fromChainId,
  toChainId,
}: GetBridgeFeesArgs): Promise<GetBridgeFeesResult> {
  const timeBeforeRequests = Date.now();
  const {
    relayerFee,
    relayerGasFee,
    relayerCapitalFee,
    isAmountTooLow,
    quoteTimestamp,
    quoteBlock,
    lpFee,
  } = await getApiEndpoint().suggestedFees(
    amount,
    getConfig().getTokenInfoBySymbol(fromChainId, tokenSymbol).address,
    toChainId,
    fromChainId
  );
  const timeAfterRequests = Date.now();

  const quoteLatency = BigNumber.from(timeAfterRequests - timeBeforeRequests);

  return {
    relayerFee,
    relayerGasFee,
    relayerCapitalFee,
    lpFee,
    isAmountTooLow,
    quoteTimestamp,
    quoteTimestampInMs: quoteTimestamp.mul(1000),
    quoteBlock,
    quoteLatency,
  };
}

export type ConfirmationDepositTimeType = {
  formattedString: string;
  lowEstimate: number;
  highEstimate: number;
};

export const getConfirmationDepositTime = (
  amount: BigNumber,
  limits: BridgeLimitInterface,
  toChain: ChainId,
  fromChain: ChainId
): ConfirmationDepositTimeType => {
  const config = getConfig();
  const depositDelay = config.depositDelays()[fromChain] || 0;
  const getTimeEstimateString = (
    lowEstimate: number,
    highEstimate: number
  ): {
    formattedString: string;
    lowEstimate: number;
    highEstimate: number;
  } => {
    return {
      formattedString: `~${lowEstimate + depositDelay}-${
        highEstimate + depositDelay
      } minutes`,
      lowEstimate: lowEstimate + depositDelay,
      highEstimate: highEstimate + depositDelay,
    };
  };

  if (amount.lte(limits.maxDepositInstant)) {
    return getTimeEstimateString(1, 5);
  } else if (amount.lte(limits.maxDepositShortDelay)) {
    // This is just a rough estimate of how long 2 bot runs (1-4 minutes allocated for each) + an arbitrum transfer of 3-10 minutes would take.
    if (toChain === ChainId.ARBITRUM) return getTimeEstimateString(5, 15);

    // Optimism transfers take about 10-20 minutes anecdotally.
    if (toChain === ChainId.OPTIMISM) {
      return getTimeEstimateString(12, 25);
    }

    // Polygon transfers take 20-30 minutes anecdotally.
    if (toChain === ChainId.POLYGON) return getTimeEstimateString(20, 35);

    // Typical numbers for an arbitrary L2.
    return getTimeEstimateString(10, 30);
  }

  // If the deposit size is above those, but is allowed by the app, we assume the pool will slow relay it.
  return { formattedString: "~3-7 hours", lowEstimate: 180, highEstimate: 420 };
};

export type AcrossDepositArgs = {
  fromChain: ChainId;
  toChain: ChainId;
  toAddress: string;
  amount: ethers.BigNumber;
  tokenAddress: string;
  relayerFeePct: ethers.BigNumber;
  timestamp: ethers.BigNumber;
  referrer?: string;
  isNative: boolean;
};
type AcrossApprovalArgs = {
  chainId: ChainId;
  tokenAddress: string;
  amount: ethers.BigNumber;
};
/**
 * Makes a deposit on Across.
 * @param signer A valid signer, must be connected to a provider.
 * @param depositArgs - An object containing the {@link AcrossDepositArgs arguments} to pass to the deposit function of the bridge contract.
 * @returns The transaction response obtained after sending the transaction.
 */
export async function sendAcrossDeposit(
  signer: ethers.Signer,
  {
    fromChain,
    tokenAddress,
    amount,
    toAddress: recipient,
    toChain: destinationChainId,
    relayerFeePct,
    timestamp: quoteTimestamp,
    isNative,
    referrer,
  }: AcrossDepositArgs
): Promise<ethers.providers.TransactionResponse> {
  const config = getConfig();
  const spokePool = config.getSpokePool(fromChain);
  const provider = getProvider(fromChain);
  const code = await provider.getCode(spokePool.address);
  if (!code) {
    throw new Error(`SpokePool not deployed at ${spokePool.address}`);
  }
  const value = isNative ? amount : ethers.constants.Zero;
  const tx = await spokePool.populateTransaction.deposit(
    recipient,
    tokenAddress,
    amount,
    destinationChainId,
    relayerFeePct,
    quoteTimestamp,
    { value }
  );

  // do not tag a referrer if data is not provided as a hex string.
  tx.data =
    referrer && ethers.utils.isAddress(referrer)
      ? tagAddress(tx.data!, referrer, referrerDelimiterHex)
      : tx.data;

  return signer.sendTransaction(tx);
}

export async function sendAcrossApproval(
  signer: ethers.Signer,
  { tokenAddress, amount, chainId }: AcrossApprovalArgs
): Promise<ethers.providers.TransactionResponse> {
  const config = getConfig();
  const spokePool = config.getSpokePool(chainId, signer);
  const provider = getProvider(chainId);
  const code = await provider.getCode(spokePool.address);
  if (!code) {
    throw new Error(`SpokePool not deployed at ${spokePool.address}`);
  }
  const tokenContract = clients.erc20.connect(tokenAddress, signer);
  return tokenContract.approve(spokePool.address, amount);
}
