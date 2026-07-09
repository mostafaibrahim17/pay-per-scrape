import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { createPublicClient, http, parseAbiItem, decodeEventLog } from 'viem';
import { base } from 'viem/chains';

interface X402Receipt {
  txHash: `0x${string}`;
  payer: string;      // informational only, the real payer is read on-chain
  amount: bigint;     // informational only, the real amount is read on-chain
  recipient: string;  // informational only, the real recipient is read on-chain
  nonce: string;
  timestamp: number;  // unix seconds
}

const client = createPublicClient({
  chain: base,
  transport: http(),
});

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const TRANSFER_ABI = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

interface VerifiedPayment {
  ok: boolean;
  onChainPayer?: string;
  onChainAmount?: bigint;
}

async function verifyReceipt(receipt: X402Receipt): Promise<VerifiedPayment> {
  const { txHash, nonce, timestamp } = receipt;

  const alreadyUsed = await Actor.getValue(nonce);
  if (alreadyUsed) {
    log.info(`Rejected: receipt already used - ${nonce}`);
    return { ok: false };
  }

  const age = Math.floor(Date.now() / 1000) - timestamp;
  const maxAge = Number(process.env.MAX_RECEIPT_AGE_SECONDS ?? 300);
  if (age > maxAge) {
    log.info(`Rejected: receipt is ${age}s old`);
    return { ok: false };
  }

  let tx = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      tx = await client.getTransactionReceipt({ hash: txHash });
      if (tx) break;
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!tx || tx.status !== 'success') {
    log.info(`Rejected: transaction not found - ${txHash}`);
    return { ok: false };
  }

  const transferLog = tx.logs.find(
    l => l.address.toLowerCase() === USDC_ADDRESS.toLowerCase()
  );

  if (!transferLog) {
    log.info('Rejected: no USDC transfer found in transaction logs');
    return { ok: false };
  }

  let actualFrom: string;
  let actualTo: string;
  let actualValue: bigint;

  try {
    const decoded = decodeEventLog({
      abi: [TRANSFER_ABI],
      data: transferLog.data,
      topics: transferLog.topics,
    });
    actualFrom = (decoded.args as any).from as string;
    actualTo = (decoded.args as any).to as string;
    actualValue = (decoded.args as any).value as bigint;
  } catch {
    log.info('Rejected: could not decode USDC transfer log');
    return { ok: false };
  }

  const minPayment = BigInt(process.env.MIN_PAYMENT_USDC ?? '1000000');
  const correctRecipient = actualTo.toLowerCase() === process.env.WALLET_ADDRESS?.toLowerCase();
  const enoughPaid = actualValue >= minPayment;

  if (!correctRecipient || !enoughPaid) {
    log.info(`Rejected: on-chain recipient ok=${correctRecipient}, amount ok=${enoughPaid}`);
    return { ok: false };
  }

  // Return the values read from the blockchain, not the agent's claims,
  // so the handler logs what actually happened on-chain.
  return { ok: true, onChainPayer: actualFrom, onChainAmount: actualValue };
}

Actor.main(async () => {
  const input = await Actor.getInput<{
    url: string;
    receipt: X402Receipt;
  }>();

  if (!input?.url || !input?.receipt) {
    throw new Error('Missing url or receipt in input');
  }

  const { url, receipt } = input;

  const payment = await verifyReceipt(receipt);
  if (!payment.ok) {
    await Actor.setValue('result', { error: 'Payment check failed' });
    return;
  }

  // Mark the nonce as used before scraping, not after.
  // If the scrape crashes, the receipt is already burned.
  // The agent resubmits with a new payment. Marking it after
  // would let a crash turn into a free retry.
  await Actor.setValue(receipt.nonce, true);

  const pageText: string[] = [];

  const crawler = new CheerioCrawler({
    async requestHandler({ $ }) {
      $('script, style, nav, footer, header').remove();
      pageText.push(
        $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000)
      );
    },
  });

  await crawler.run([url]);

  await Actor.pushData({
    url,
    payer: payment.onChainPayer,
    amountUsdc: (Number(payment.onChainAmount) / 1_000_000).toFixed(6),
    txHash: receipt.txHash,
    nonce: receipt.nonce,
    scrapedAt: new Date().toISOString(),
    contentLength: pageText[0]?.length ?? 0,
  });

  await Actor.setValue('result', {
    data: pageText[0] ?? '',
    url,
    txHash: receipt.txHash,
  });
});