import { describe, it, expect } from 'vitest';
import { Transaction, Wallet } from 'ethers';
import { decodeChainFor, parseSerializedTransaction, serializedTxWarnings } from './rawTx.ts';

/** Throwaway test key (well known: Hardhat account #0). Never holds funds. */
const wallet = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TRANSFER =
  '0xa9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000005f5e100';

describe('parseSerializedTransaction', () => {
  it('reads a signed EIP-1559 transaction and recovers the sender', async () => {
    const raw = await wallet.signTransaction({
      type: 2,
      chainId: 8453,
      nonce: 7,
      to: USDC,
      value: 0,
      data: TRANSFER,
      gasLimit: 60000,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
    const tx = parseSerializedTransaction(raw);
    expect(tx).toMatchObject({ type: 2, chainId: 8453, nonce: 7, to: USDC, value: '0', data: TRANSFER, from: wallet.address });
    expect(tx.hash).toBe(Transaction.from(raw).hash);
    expect(decodeChainFor(tx, 1)).toBe(8453);
    expect(serializedTxWarnings(tx, 8453)).toEqual([]);
  });

  it('flags EIP-7702 delegations and names the account that signed them', async () => {
    const auth = wallet.authorizeSync({ address: '0x1111111111111111111111111111111111111111', nonce: 8, chainId: 0 });
    const raw = await wallet.signTransaction({
      type: 4,
      chainId: 1,
      nonce: 7,
      to: wallet.address,
      data: '0x',
      gasLimit: 100000,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      authorizationList: [auth],
    });
    const tx = parseSerializedTransaction(raw);
    expect(tx.authorizations).toEqual([
      { address: '0x1111111111111111111111111111111111111111', chainId: '0', nonce: '8', signer: wallet.address },
    ]);
    const [w] = serializedTxWarnings(tx, 1);
    expect(w.severity).toBe('danger');
    expect(w.message).toContain(wallet.address);
    expect(w.message).toContain('every chain');
  });

  it('reads unsigned and pre-EIP-155 transactions', () => {
    const unsigned = Transaction.from({ type: 2, chainId: 1, to: USDC, data: TRANSFER, gasLimit: 1, maxFeePerGas: 1, maxPriorityFeePerGas: 1 }).unsignedSerialized;
    const tx = parseSerializedTransaction(unsigned);
    expect(tx.from).toBeNull();
    expect(serializedTxWarnings(tx, 1).map(w => w.title)).toEqual(['Unsigned transaction']);

    const legacy = Transaction.from({ type: 0, to: USDC, data: TRANSFER, gasLimit: 1, gasPrice: 1 }).unsignedSerialized;
    const ltx = parseSerializedTransaction(legacy);
    expect(ltx.chainId).toBeNull();
    expect(serializedTxWarnings(ltx, 1).map(w => w.title)).toContain('No replay protection');
  });

  it('rejects calldata with a readable error', () => {
    expect(() => parseSerializedTransaction(TRANSFER)).toThrow(/Not a serialized transaction/);
    expect(() => parseSerializedTransaction('hello')).toThrow(/hex/);
  });
});
