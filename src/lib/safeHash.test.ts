import { describe, it, expect } from 'vitest';
import { AbiCoder, keccak256 } from 'ethers';
import { computeSafeTxHashes, safeTxAsExecCalldata, safeVersionRange, type SafeTxFields } from './safeHash.ts';

/**
 * Mainnet Safe 1.4.1 at 0xf9c3…3e78, nonce 44, tx 0x92075325…2518 (block 26332427). Its ExecutionSuccess event
 * logged safeTxHash 0xe9c0fb94…56aa; the calldata below is that transaction's input.
 */
const SAFE = '0xf9c3f17ea1647a6e51352860388dd04b08263e78';
const EXEC_INPUT =
  '0x6a7612020000000000000000000000004c9edd5852cd905f086c759e8383e09bff1e68b30000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000000000044a9059cbb00000000000000000000000053d87b3bd0b6d5c4cb8cc7877321ec61c66de0d3000000000000000000000000000000000000000000000697d4ec63b33b1c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000412a8d5e70c0848c776ea6ddbb0a5cd76fb11fd209a31364982215a72a4a88c7b175b78ea30ba0c6e75ef196d14c8f16fb8a5a3103360793eda5cb57a6252862ab1b00000000000000000000000000000000000000000000000000000000000000';

function fieldsFromExec(input: string, nonce: string): SafeTxFields {
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver] = AbiCoder.defaultAbiCoder().decode(
    ['address', 'uint256', 'bytes', 'uint8', 'uint256', 'uint256', 'uint256', 'address', 'address', 'bytes'],
    `0x${input.slice(10)}`,
  );
  return {
    to,
    value: value.toString(),
    data,
    operation: Number(operation),
    safeTxGas: safeTxGas.toString(),
    baseGas: baseGas.toString(),
    gasPrice: gasPrice.toString(),
    gasToken,
    refundReceiver,
    nonce,
  };
}

describe('computeSafeTxHashes', () => {
  it('matches the safeTxHash a real Safe logged on chain', () => {
    const h = computeSafeTxHashes(1, SAFE, '1.3+', fieldsFromExec(EXEC_INPUT, '44'));
    expect(h.safeTxHash).toBe('0xe9c0fb9419e3d462695ac09fb5e79deda67633d277d8c9f7c29be42f661b56aa');
  });

  it('leaves the chain id out of the domain before 1.3.0', () => {
    const h = computeSafeTxHashes(1, SAFE, '1.0-1.2', fieldsFromExec(EXEC_INPUT, '44'));
    // keccak256(abi.encode(keccak256("EIP712Domain(address verifyingContract)"), safe)) — Safe 1.0–1.2 DOMAIN_SEPARATOR.
    const expected = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address'],
        ['0x035aff83d86937d35b32e04f0ddc6ff469290eef2f1b692d8a815c89404d4749', SAFE],
      ),
    );
    expect(h.domainHash).toBe(expected);
  });

  it('names the field that is wrong', () => {
    expect(() => computeSafeTxHashes(1, SAFE, '1.3+', { ...fieldsFromExec(EXEC_INPUT, '44'), nonce: 'abc' })).toThrow(/Nonce/);
    expect(() => computeSafeTxHashes(1, SAFE, '1.3+', { ...fieldsFromExec(EXEC_INPUT, '44'), to: '0x12' })).toThrow(/To/);
  });
});

describe('safeTxAsExecCalldata', () => {
  it('rebuilds execTransaction with empty signatures', () => {
    const rebuilt = safeTxAsExecCalldata(fieldsFromExec(EXEC_INPUT, '44'));
    expect(rebuilt.slice(0, 10)).toBe('0x6a761202');
    expect(fieldsFromExec(rebuilt, '44')).toEqual(fieldsFromExec(EXEC_INPUT, '44'));
  });
});

describe('safeVersionRange', () => {
  it('maps VERSION() strings to hashing schemes', () => {
    expect(safeVersionRange('1.4.1')).toBe('1.3+');
    expect(safeVersionRange('1.3.0+L2')).toBe('1.3+');
    expect(safeVersionRange('1.1.1')).toBe('1.0-1.2');
    expect(safeVersionRange('0.1.0')).toBe('0.x');
  });
});
