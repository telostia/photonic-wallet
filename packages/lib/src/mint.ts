import { encodeAtom, isImmutableToken } from "./atom";
import {
  commitScriptSize,
  dMintDiffToTarget,
  dMintScript,
  datCommitScript,
  delegateBaseScript,
  delegateBurnScript,
  delegateBurnScriptSize,
  delegateTokenScript,
  ftCommitScript,
  ftScript,
  ftScriptSize,
  mutableNftScript,
  mutableNftScriptSize,
  nftCommitScript,
  nftScript,
  nftScriptSize,
  p2pkhScript,
  p2pkhScriptSigSize,
  p2pkhScriptSize,
  parseNftScript,
  revealScriptSigSize,
  txSize,
} from "./script";
import {
  AtomPayload,
  CommitOperation,
  TokenCommitData,
  RevealDirectParams,
  RevealPsbtParams,
  TokenRevealParams,
  UnfinalizedInput,
  UnfinalizedOutput,
  Utxo,
  RevealDmintParams,
  DeployMethod,
} from "./types";
import { fundTx, targetToUtxo, updateUnspent } from "./coinSelect";
import { buildTx } from "./tx";
import Outpoint from "./Outpoint";
import rjs from "@radiantblockchain/radiantjs";
const { Script, crypto } = rjs;

const defaultFeeRate = 5000;

export function commitBundle(
  deployMethod: DeployMethod,
  address: string,
  wif: string,
  utxos: Utxo[],
  tokens: {
    operation: CommitOperation;
    outputValue: number;
    payload: AtomPayload;
  }[],
  delegate:
    | {
        ref: string;
        utxos: Utxo[];
      }
    | undefined,
  batchSize: number,
  onProgress?: (k: string) => void
) {
  const p2pkh = p2pkhScript(address);
  const batches = new Array(Math.ceil(tokens.length / batchSize))
    .fill(null)
    .map((_, i) => tokens.slice(i * batchSize, (i + 1) * batchSize));

  // Create funding outputs for each batch
  const target = batches.map((batch) => ({
    script: p2pkh,
    value:
      txSize(
        [p2pkhScriptSigSize].concat(delegate ? [p2pkhScriptSigSize] : []),
        batch.flatMap((token) => {
          const hasDelegate = !!(
            token.payload.by?.length || token.payload.in?.length
          );
          const extraRefRequired =
            isImmutableToken(token.payload) || deployMethod === "dmint";
          return [commitScriptSize(token.operation, hasDelegate)].concat(
            extraRefRequired ? [] : [p2pkhScriptSize]
          );
        })
      ) * defaultFeeRate,
  }));

  const {
    funding: inputs,
    change,
    remaining,
    fee,
  } = fundTx(address, utxos, [], target, p2pkh, defaultFeeRate);

  // TODO should delegate token creation be merged with funding UTXOs?

  onProgress && onProgress("sign");
  const outputs = target.concat(change?.length ? change : []);
  const funding = buildTx(address, wif, inputs, outputs, false);

  const commits = batches.map((batch, vout) =>
    commitBatch(
      deployMethod,
      address,
      wif,
      batch,
      { txid: funding.id, vout, ...outputs[vout] },
      delegate && { ref: delegate.ref, utxo: delegate.utxos[vout] }
    )
  );

  // Create change UTXOs
  const changeUtxos = targetToUtxo(change, funding.id, target.length);

  return {
    funding: funding.toString(),
    commits,
    remaining,
    change: changeUtxos,
    fees: [fee, ...target.map((t) => t.value)],
  };
}

// Deploy method must be know in advance so sequential dmint refs for minting and token contracts can be prepared
export function createCommitOutputs(
  operation: CommitOperation,
  deployMethod: DeployMethod,
  address: string,
  payload: AtomPayload,
  delegate?: {
    ref: string;
    utxo: Utxo;
  }
) {
  const p2pkh = p2pkhScript(address);
  const immutable = isImmutableToken(payload);
  const atom = encodeAtom(operation, payload);
  const scriptFn = {
    nft: nftCommitScript,
    ft: ftCommitScript,
    dat: datCommitScript,
  }[operation];
  const script = scriptFn(address, atom.payloadHash, delegate?.ref);
  const outputs: UnfinalizedOutput[] = [];

  outputs.push({ script, value: 1 });
  if (operation === "nft" && !immutable) {
    // Prepare a ref for the mutable contract. This will be token ref + 1.
    outputs.push({ script: p2pkh, value: 1 });
  }

  if (operation === "ft" && deployMethod === "dmint") {
    // Two outputs are required for contract ref and token ref
    outputs.push({ script: p2pkh, value: 1 });
  }

  return {
    utxo: {
      script,
      value: 1,
    },
    immutable,
    atom,
    outputs,
  };
}

export function commitBatch(
  deployMethod: DeployMethod,
  address: string,
  wif: string,
  ops: {
    operation: CommitOperation;
    outputValue: number;
    payload: AtomPayload;
  }[],
  funding: Utxo,
  delegate?: {
    ref: string;
    utxo: Utxo;
  }
) {
  const outputs: UnfinalizedOutput[] = [];
  let vout = 0;
  const reveals = ops.map(({ operation, outputValue, payload }) => {
    const { outputs: commitOutputs, ...rest } = createCommitOutputs(
      operation,
      deployMethod,
      address,
      payload,
      delegate
    );
    outputs.push(...commitOutputs);

    const obj = {
      ...rest,
      utxo: {
        vout,
        ...rest.utxo,
      },
      outputValue,
    };

    vout += obj.immutable ? 1 : 2;

    return obj;
  });

  const tx = buildTx(
    address,
    wif,
    [funding].concat(delegate ? delegate.utxo : []),
    outputs,
    false
  );

  // Add txid to utxo objects
  const withTxid: TokenCommitData[] = reveals.map(({ utxo, ...r }) => ({
    utxo: { txid: tx.id, ...utxo },
    ...r,
  }));

  return { txid: tx.id, tx: tx.toString(), data: withTxid };
}

export function revealDirect(
  address: string,
  wif: string,
  utxos: Utxo[],
  tokens: TokenCommitData[],
  revealParams: { [key: string]: TokenRevealParams },
  batchSize: number,
  delegateRef: string | undefined
) {
  const p2pkh = p2pkhScript(address);
  const batches = new Array(Math.ceil(tokens.length / batchSize))
    .fill(null)
    .map((_, i) => tokens.slice(i * batchSize, (i + 1) * batchSize));

  // Create funding outputs for each batch
  const target = batches.map((batch) => ({
    script: p2pkh,
    value:
      txSize(
        batch
          .flatMap((t) =>
            [revealScriptSigSize(t.atom.script.length / 2)].concat(
              t.immutable ? [] : [p2pkhScriptSigSize]
            )
          )
          .concat(p2pkhScriptSigSize),
        // Output script sizes for fee calculation
        batch
          .flatMap((t) =>
            ([] as number[])
              .concat(t.atom.operation === "nft" ? [nftScriptSize] : [])
              .concat(t.atom.operation === "ft" ? [ftScriptSize] : [])
              .concat(
                t.atom.operation === "nft" && !t.immutable
                  ? [mutableNftScriptSize]
                  : []
              )
          )
          .concat(delegateRef ? delegateBurnScriptSize : [])
      ) *
        defaultFeeRate +
      // Output values
      batch.reduce(
        (a, t) =>
          a +
          (["nft", "ft"].includes(t.atom.operation) ? t.outputValue : 0) +
          (t.atom.operation === "nft" && !t.immutable ? 1 : 0), // 1 photon mutable output
        0
      ),
  }));

  const {
    funding: inputs,
    change,
    remaining,
    fee,
  } = fundTx(address, utxos, [], target, p2pkh, defaultFeeRate);

  const outputs = target.concat(change?.length ? change : []);
  const funding = buildTx(address, wif, inputs, outputs, false);
  const reveals = batches.map((batch, vout) =>
    revealBatch(
      address,
      wif,
      batch,
      "direct",
      revealParams,
      { txid: funding.id, vout, ...outputs[vout] },
      delegateRef
    )
  );

  // Create change UTXOs
  const changeUtxos = targetToUtxo(change, funding.id, target.length);

  return {
    funding: funding.toString(),
    reveals,
    remaining,
    change: changeUtxos,
    fees: [fee, ...target.map((t) => t.value)],
  };
}

// Create outputs for a single token reveal
// Not used for PSBT deployments
export function createRevealOutputs(
  creatorAddress: string,
  { atom, outputValue, immutable, utxo }: TokenCommitData,
  deployMethod: DeployMethod,
  deployParams: RevealDirectParams | RevealDmintParams
) {
  if (deployMethod === "dmint" && atom.operation !== "ft") {
    throw new Error("Operation does not support dmint deployments");
  }

  const p2pkh = p2pkhScript(creatorAddress);
  const tokenRef = Outpoint.fromObject(utxo).reverse().toString();
  const inputs: UnfinalizedInput[] = [];
  const outputs: UnfinalizedOutput[] = [];

  if (atom.operation === "nft") {
    outputs.push({
      script: nftScript(deployParams.address, tokenRef),
      value: outputValue,
    });
    console.debug("Added NFT output", {
      address: deployParams.address,
      tokenRef,
    });
  } else if (atom.operation === "ft") {
    if (deployMethod === "direct") {
      outputs.push({
        script: ftScript(deployParams.address, tokenRef),
        value: outputValue,
      });
      console.debug("Added FT output", {
        address: deployParams.address,
        tokenRef,
      });
    } else if (deployMethod === "dmint") {
      const dmintParams = deployParams as RevealDmintParams;
      // dmint contract ref is token ref + 1
      const contractRef = Outpoint.fromUTXO(utxo.txid, utxo.vout + 1)
        .reverse()
        .ref();

      for (let i = 0; i < dmintParams.numContracts; i++) {
        outputs.push({
          script: dMintScript(
            0,
            contractRef,
            tokenRef,
            dmintParams.maxHeight,
            dmintParams.reward,
            dMintDiffToTarget(dmintParams.difficulty)
          ),
          value: outputValue,
        });
      }
      console.debug("Added dmint output", {
        tokenRef,
      });
    }
  }

  inputs.push({
    ...utxo,
    // Add script sig size in case it's needed for fee calculation
    // Batch reveals will already handle this with txSize but single mints require it
    scriptSigSize: revealScriptSigSize(atom.script.length / 2),
  });

  if (atom.operation === "ft" && deployMethod === "dmint") {
    // Add input for creating the dmint contract ref
    inputs.push({
      txid: utxo.txid,
      vout: utxo.vout + 1,
      value: 1,
      script: p2pkh,
    });
  }

  if (atom.operation === "nft" && !immutable) {
    const mutableRef = Outpoint.fromUTXO(utxo.txid, utxo.vout + 1)
      .reverse()
      .ref();
    inputs.push({
      txid: utxo.txid,
      vout: utxo.vout + 1,
      value: 1,
      script: p2pkh,
    });
    outputs.push({
      script: mutableNftScript(mutableRef, atom.payloadHash),
      value: 1,
    });
    console.debug("Added mutable contract output", {
      mutableRef,
      tokenRef,
    });
  }

  return { inputs, outputs };
}

export function revealBatch(
  address: string,
  wif: string,
  tokens: TokenCommitData[],
  deployMethod: DeployMethod,
  revealParams: { [key: string]: TokenRevealParams },
  funding: Utxo,
  delegateRef: string | undefined
) {
  const outputs: UnfinalizedOutput[] = [];
  const inputs: Utxo[] = [];
  const tokenScriptSigs: { [key: number]: string } = {}; // Keep track of token outputs so script sig can be modified later
  if (delegateRef) {
    outputs.push({
      script: delegateBurnScript(delegateRef),
      value: 0,
    });
  }
  const refs: string[] = [];
  tokens.forEach((token) => {
    const { atom, utxo } = token;
    tokenScriptSigs[inputs.length] = atom.script;
    const outpoint = Outpoint.fromObject(utxo);
    const params = revealParams[outpoint.toString()] as RevealDirectParams;
    const revealTxos = createRevealOutputs(
      address,
      token,
      deployMethod,
      params
    );
    inputs.push(...revealTxos.inputs);
    outputs.push(...revealTxos.outputs);
    refs.push(outpoint.toString());
  });

  const tx = buildTx(
    address,
    wif,
    [...inputs, funding],
    outputs,
    false,
    (index, script) => {
      if (tokenScriptSigs[index]) {
        script.add(Script.fromString(tokenScriptSigs[index]));
      }
    }
  );

  return { txid: tx.id, tx: tx.toString(), refs };
}

// Create asset base transaction for a delegate ref
export function createDelegateBase(
  address: string,
  wif: string,
  utxos: Utxo[],
  tokens: Utxo[]
) {
  const refs: string[] = tokens
    .map(({ script }) => parseNftScript(script).ref as string)
    .filter(Boolean);
  if (refs.length !== tokens.length) {
    throw Error("Token cannot be used for ref delegate");
  }
  const script = delegateBaseScript(address, refs);
  const p2pkh = p2pkhScript(address);
  const base = { script, value: 1 };
  const inputs = [...tokens];
  const outputs = [base, ...tokens];

  const { change, funding, fee, remaining } = fundTx(
    address,
    utxos,
    inputs,
    outputs,
    p2pkh,
    defaultFeeRate
  );
  inputs.push(...funding);
  outputs.push(...change);
  const tx = buildTx(address, wif, inputs, outputs, false);

  // Create change UTXOs
  const changeUtxos = targetToUtxo(change, tx.id, 1 + tokens.length);
  const baseUtxo = targetToUtxo([base], tx.id)[0];

  return { tx, utxo: baseUtxo, change: changeUtxos, fee, remaining };
}

// Create transaction for minting a number of delegate token outputs
export function createDelegateTokens(
  address: string,
  wif: string,
  utxos: Utxo[],
  base: Utxo,
  numTokens: number
) {
  const p2pkh = p2pkhScript(address);
  const ref = Outpoint.fromObject(base).reverse().ref();
  const script = delegateTokenScript(address, ref);
  const inputs = [base];
  const outputs = new Array(numTokens).fill({
    script,
    value: 1,
  });

  const { change, fee, funding, remaining } = fundTx(
    address,
    utxos,
    inputs,
    outputs,
    p2pkh,
    defaultFeeRate
  );
  inputs.push(...funding);
  outputs.push(...change);
  const tx = buildTx(address, wif, inputs, outputs, false);
  const newUtxos = targetToUtxo(outputs, tx.id);
  const delegateTokens = newUtxos.slice(0, numTokens);
  const changeUtxos = newUtxos.slice(numTokens);

  return {
    tx: tx.toString(),
    delegateTokens,
    remaining,
    fee,
    change: changeUtxos,
  };
}

export function revealPsbt(
  wif: string,
  tokens: TokenCommitData[],
  revealParams: { [key: string]: RevealPsbtParams }
) {
  const txs: { reveal: string; mutable?: string }[] = [];
  const outpointTokenMap = Object.fromEntries(
    tokens.map((t) => [Outpoint.fromObject(t.utxo), t])
  );

  // Iterate revealParams object so transactions can be selectively created
  Object.entries(revealParams).forEach(([k, { photons, address }]) => {
    const { atom, utxo, immutable } = outpointTokenMap[k];
    const txObj: { reveal: string; mutable?: string } = {
      reveal: buildTx(
        address,
        wif,
        [utxo],
        [{ script: p2pkhScript(address), value: photons }],
        false,
        (_, script) => {
          script.add(Script.fromString(atom.script));
        },
        crypto.Signature.SIGHASH_SINGLE | crypto.Signature.SIGHASH_ANYONECANPAY
      ).toString(),
    };

    // Mutable contract transactions are created as SIGHASH_ALL | ANYONECANPAY
    // These transactions only require a funding input to be added by the buyer and is broadcast separate to the token reveal transaction
    if (!immutable) {
      const mutableRef = Outpoint.fromObject(utxo).reverse().ref();
      txObj.mutable = buildTx(
        address,
        wif,
        [
          {
            txid: utxo.txid,
            vout: utxo.vout + 1,
            value: 1,
            script: "",
          },
        ],
        [
          {
            script: mutableNftScript(mutableRef, atom.payloadHash),
            value: 1,
          },
        ],
        false,
        undefined,
        crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_ANYONECANPAY
      ).toString();
    }

    txs.push(txObj);
  });
  return txs;
}

// Mint a single token
export function mintToken(
  operation: CommitOperation,
  deployMethod: "direct" | "dmint",
  deployParams: RevealDirectParams | RevealDmintParams, // PSBT not supported for single mints
  outputValue: number,
  wif: string,
  utxos: Utxo[],
  payload: AtomPayload,
  relUtxos: Utxo[],
  feeRate: number
) {
  if (deployMethod === "dmint" && operation !== "ft") {
    throw new Error("Operation does not support dmint deployments");
  }

  let unspentRxd = utxos;
  const fees: number[] = [];
  const { outputs, ...partialCommitData } = createCommitOutputs(
    operation,
    deployMethod,
    deployParams.address,
    payload
  );
  const p2pkh = p2pkhScript(deployParams.address);
  const commitFund = fundTx(
    deployParams.address,
    unspentRxd,
    [],
    outputs,
    p2pkh,
    feeRate
  );
  fees.push(commitFund.fee);
  const commitOutputs = [...outputs, ...commitFund.change];
  const commitTx = buildTx(
    deployParams.address,
    wif,
    commitFund.funding,
    commitOutputs,
    false
  );

  unspentRxd = updateUnspent(commitFund, commitTx.id, outputs.length);

  const commitData: TokenCommitData = {
    ...partialCommitData,
    utxo: {
      txid: commitTx.id,
      vout: 0,
      ...partialCommitData.utxo,
    },
    outputValue,
  };

  const revealTarget = createRevealOutputs(
    deployParams.address,
    commitData,
    deployMethod,
    deployParams
  );

  // Since this is just a single token, related tokens will be referenced directly in the transaction instead of a delegate
  const revealInputs = [
    ...revealTarget.inputs, // Commit UTXO. This must be first so setInputScript works.
    ...relUtxos, // Related tokens
  ];
  const revealOutputs = [
    ...revealTarget.outputs, // Minted token
    ...relUtxos, // Related tokens
  ];

  const revealFund = fundTx(
    deployParams.address,
    unspentRxd,
    revealInputs,
    revealOutputs,
    p2pkh,
    feeRate
  );
  fees.push(revealFund.fee);

  revealInputs.push(
    ...revealFund.funding // Funding
  );
  revealOutputs.push(
    ...revealFund.change //Change
  );

  const revealTx = buildTx(
    deployParams.address,
    wif,
    revealInputs,
    revealOutputs,
    false,
    (index, script) => {
      if (index === 0) {
        script.add(Script.fromString(commitData.atom.script));
      }
    }
  );

  const size = commitTx.toBuffer().length + revealTx.toBuffer().length;
  const ref = Outpoint.fromObject(commitData.utxo);

  return {
    commitTx,
    revealTx,
    fees,
    size,
    ref,
  };
}
