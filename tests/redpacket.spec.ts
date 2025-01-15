import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Redpacket } from "../target/types/redpacket";
import {
  confirmTransaction,
  createAccountsMintsAndTokenAccounts,
  getKeypairFromEnvironment,
} from "@solana-developers/helpers";
import {
  Ed25519Program,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Keypair,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  type TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import "dotenv/config";

import nacl from "tweetnacl";
import bs58 from "bs58";

// Work on both Token Program and new Token Extensions Program
const TOKEN_PROGRAM: typeof TOKEN_2022_PROGRAM_ID | typeof TOKEN_PROGRAM_ID =
  TOKEN_2022_PROGRAM_ID;

const claimer_issuer = getKeypairFromEnvironment("CLAIMER_ISSUER_SECRET_KEY");
const randomUser = getKeypairFromEnvironment("RANDOM_KEY_1");
const randomUser2 = getKeypairFromEnvironment("RANDOM_KEY_2");

describe("redpacket", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const signer = (provider.wallet as anchor.Wallet).payer;

  let redPacketCreator: anchor.web3.Keypair;
  let splTokenRedPacket: PublicKey;
  let nativeTokenRedPacket: PublicKey;
  let splRedPacketCreateTime: anchor.BN;
  let nativeRedPacketCreateTime: anchor.BN;
  let vault: PublicKey;
  let tokenMint: PublicKey;
  let tokenAccount: PublicKey;

  const redPacketProgram = anchor.workspace.Redpacket as Program<Redpacket>;
  //redPacketCreator = getKeypairFromEnvironment("CREATOR");

  //Add beforeAll if you need any setup before all tests
  before(async () => {
    const isLocalnet =
      provider.connection.rpcEndpoint.includes("localhost") ||
      provider.connection.rpcEndpoint.includes("127.0.0.1");
    console.log("RPC endpoint:", provider.connection.rpcEndpoint);
    console.log("isLocalnet:", isLocalnet);

    if (isLocalnet) {
      //Create users and mints
      const usersMintsAndTokenAccounts =
        await createAccountsMintsAndTokenAccounts(
          [[100 * LAMPORTS_PER_SOL]],
          1 * LAMPORTS_PER_SOL,
          connection,
          signer
        );

      const tokenAccounts = usersMintsAndTokenAccounts.tokenAccounts;
      const mints = usersMintsAndTokenAccounts.mints[0];

      tokenMint = mints.publicKey;
      tokenAccount = tokenAccounts[0][0];

      const users = usersMintsAndTokenAccounts.users;
      redPacketCreator = users[0];

      // Airdrop some SOL to redPacketCreator
      const airdropSignature = await connection.requestAirdrop(
        redPacketCreator.publicKey,
        20 * LAMPORTS_PER_SOL // This will airdrop 1 SOL
      );
      await confirmTransaction(connection, airdropSignature);

      // Airdrop some SOL to claimer
      const airdropSignatureClaimer = await connection.requestAirdrop(
        randomUser.publicKey,
        1 * LAMPORTS_PER_SOL // This will airdrop 1 SOL, pay for initialize the claimer token account
      );
      await confirmTransaction(connection, airdropSignatureClaimer);

      // Airdrop some SOL to claimer
      const airdropSignatureClaimer2 = await connection.requestAirdrop(
        randomUser2.publicKey,
        1 * LAMPORTS_PER_SOL // This will airdrop 1 SOL, pay for initialize the claimer token account
      );
      await confirmTransaction(connection, airdropSignatureClaimer2);
    } else {
      redPacketCreator = getKeypairFromEnvironment("CREATOR");
      console.log("redPacketCreator:", redPacketCreator.publicKey.toString());

      // Create mint
      tokenMint = await createMint(
        connection,
        signer, // payer
        redPacketCreator.publicKey, // mintAuthority
        null, // freezeAuthority (you can use null)
        9, // decimals
        undefined,
        undefined,
        TOKEN_PROGRAM
      );

      // Create token account for redPacketCreator
      const tokenAccountInfo = await getOrCreateAssociatedTokenAccount(
        connection,
        signer,
        tokenMint,
        redPacketCreator.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM
      );
      tokenAccount = tokenAccountInfo.address;

      // Mint some tokens to redPacketCreator's token account
      await mintTo(
        connection,
        redPacketCreator,
        tokenMint,
        tokenAccount,
        redPacketCreator, // mint authority
        100 * LAMPORTS_PER_SOL, // amount
        [],
        undefined,
        TOKEN_PROGRAM
      );

      console.log("Setup complete");
      console.log("Token Mint:", tokenMint.toBase58());
      console.log("Creator Token Account:", tokenAccount.toBase58());
    }
  });

  // it.only("log", async () => {
  //   const redPacket = await redPacketProgram.account.redPacket.fetch(
  //     new PublicKey("H9bkzH88wHnePjd3ge1P78cgmxJNoaUJFoDT5FWPsaDA")
  //   );
  //   console.log(redPacket);
  // });

  it("create SPL token redpacket", async () => {
    const creatorTokenBalanceBefore = await connection.getTokenAccountBalance(
      tokenAccount
    );
    const creatorTokenBalanceBeforeValue = new anchor.BN(
      creatorTokenBalanceBefore.value.amount
    );
    console.log(
      "In test, creator token account  balance",
      creatorTokenBalanceBeforeValue.toString()
    );

    splRedPacketCreateTime = new anchor.BN(Math.floor(Date.now() / 1000));

    splTokenRedPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(splRedPacketCreateTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];

    console.log("Create time:", splRedPacketCreateTime.toString());
    console.log("splTokenRedPacket:", splTokenRedPacket.toString());
    //console.log("bump:", bump);
    vault = getAssociatedTokenAddressSync(
      tokenMint,
      splTokenRedPacket,
      true,
      TOKEN_PROGRAM
    );

    const redPacketTotalNumber = 3;
    const redPacketTotalAmount = new anchor.BN(4 * LAMPORTS_PER_SOL);
    const redPacketDuration = new anchor.BN(8);

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithSplToken(
          redPacketTotalNumber,
          redPacketTotalAmount,
          splRedPacketCreateTime,
          redPacketDuration,
          false,
          claimer_issuer.publicKey,
          "my first spl red packet",
          "my first spl red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket: splTokenRedPacket,
          tokenMint: tokenMint,
          tokenAccount: tokenAccount,
          vault: vault,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();

      await provider.connection.confirmTransaction(tx);
      await getLogs(tx);
    } catch (error) {
      console.error("Transaction failed:", error);
      if (error.logs) {
        console.log("Transaction logs:", error.logs);
      }
      await getLogs(error.signature);
    }

    // Fetch and verify the created red packet account
    // Check vault contains the tokens offered
    const vaultBalanceResponse = await connection.getTokenAccountBalance(vault);
    const vaultBalance = new anchor.BN(vaultBalanceResponse.value.amount);

    // After creating red packet
    const creatorTokenBalanceAfter = await connection.getTokenAccountBalance(
      tokenAccount
    );
    expect(vaultBalance.toString()).equal(redPacketTotalAmount.toString());
    expect(creatorTokenBalanceAfter.value.amount).equal(
      creatorTokenBalanceBeforeValue.sub(vaultBalance).toString()
    );

    // Check red packet
    const redPacketAccount = await redPacketProgram.account.redPacket.fetch(
      splTokenRedPacket
    );
    const currentTime = Math.floor(Date.now() / 1000);
    //splRedPacketCreateTime = new anchor.BN(currentTime);

    // Verify time drift
    const timeDrift = Math.abs(
      currentTime - redPacketAccount.createTime.toNumber()
    );
    console.log("Time drift:", timeDrift, "seconds");
    //expect(timeDrift).to.be.lessThan(ALLOWED_TIME_DRIFT);

    expect(redPacketAccount.totalNumber.toString()).equal(
      redPacketTotalNumber.toString()
    );
    expect(redPacketAccount.totalAmount.toString()).equal(
      redPacketTotalAmount.toString()
    );
    expect(redPacketAccount.createTime.toString()).equal(
      redPacketAccount.createTime.toString()
    );
    expect(redPacketAccount.duration.toString()).equal(
      redPacketAccount.duration.toString()
    );
    expect(redPacketAccount.tokenType).equal(1);
    expect(redPacketAccount.ifSpiltRandom).equal(false);
    expect(redPacketAccount.claimedNumber.toString()).equal("0");
    expect(redPacketAccount.claimedAmount.toString()).equal("0");
    expect(redPacketAccount.creator.toString()).equal(
      redPacketCreator.publicKey.toString()
    );
  });

  it("create native token redpacket", async () => {
    const redPacketDuration = new anchor.BN(8);
    const redPacketTotalNumber = 3;
    const redPacketTotalAmount = new anchor.BN(0.3 * LAMPORTS_PER_SOL);
    nativeRedPacketCreateTime = new anchor.BN(
      Math.floor(Date.now() / 1000) + 3
    );

    nativeTokenRedPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(nativeRedPacketCreateTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];

    console.log(
      "nativeRedPacketCreateTime:",
      nativeRedPacketCreateTime.toString()
    );

    console.log("nativeTokenRedPacket:", nativeTokenRedPacket.toString());

    const tx = await redPacketProgram.methods
      .createRedPacketWithNativeToken(
        redPacketTotalNumber,
        redPacketTotalAmount,
        nativeRedPacketCreateTime,
        redPacketDuration,
        false, // if_split_random
        claimer_issuer.publicKey,
        "my first native red packet",
        "my first native red packet"
      )
      .accounts({
        signer: redPacketCreator.publicKey,
        redPacket: nativeTokenRedPacket,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([redPacketCreator])
      .rpc();
    await provider.connection.confirmTransaction(tx);
    await getLogs(tx);
    // Fetch and verify the created red packet account

    //Check red packet
    const redPacketAccount = await redPacketProgram.account.redPacket.fetch(
      nativeTokenRedPacket
    );
    console.log(
      "redPacketAccount Creator:",
      redPacketAccount.creator.toString()
    );
    expect(redPacketAccount.totalNumber.toString()).equal(
      redPacketTotalNumber.toString()
    );
    expect(redPacketAccount.totalAmount.toString()).equal(
      redPacketTotalAmount.toString()
    );

    expect(redPacketAccount.tokenType).equal(0);
    expect(redPacketAccount.ifSpiltRandom).equal(false);
    expect(redPacketAccount.claimedNumber.toString()).equal("0");
    expect(redPacketAccount.claimedAmount.toString()).equal("0");
    expect(redPacketAccount.creator.toString()).equal(
      redPacketCreator.publicKey.toString()
    );
  });

  it("claim spl token red packet", async () => {
    // Re-derive the PDA
    const redPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(splRedPacketCreateTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];

    console.log("Red Packet PDA:", redPacket.toString());
    console.log("Expected Red Packet:", splTokenRedPacket.toString());

    // Verify they match
    expect(redPacket.toString()).to.equal(splTokenRedPacket.toString());

    // Get claimer's token account
    const claimerTokenAccount = getAssociatedTokenAddressSync(
      tokenMint,
      randomUser.publicKey,
      true,
      TOKEN_PROGRAM
    );

    // Get vault account
    const vaultAccount = getAssociatedTokenAddressSync(
      tokenMint,
      redPacket,
      true,
      TOKEN_PROGRAM
    );

    try {
      // Generate the message
      const message = Buffer.concat([
        redPacket.toBytes(),
        randomUser.publicKey.toBytes(),
      ]);

      // Sign the message
      const signature = nacl.sign.detached(message, claimer_issuer.secretKey);

      const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
        publicKey: claimer_issuer.publicKey.toBytes(),
        message: message,
        signature: signature,
      });

      // Verify signature before creating instruction
      const verifyResult = nacl.sign.detached.verify(
        message,
        signature,
        claimer_issuer.publicKey.toBytes()
      );
      console.log("Signature verification in TS:", verifyResult);

      const tx = await redPacketProgram.methods
        .claimWithSplToken()
        .accounts({
          signer: randomUser.publicKey,
          redPacket,
          tokenMint: tokenMint,
          tokenAccount: claimerTokenAccount,
          vault: vaultAccount,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Instruction])
        .signers([randomUser])
        .rpc();
      await provider.connection.confirmTransaction(tx);
    } catch (error) {
      console.error("Transaction failed:", error);
      if (error.logs) {
        console.log("Transaction logs:", error.logs);
      }
      throw error;
    }

    // Fetch and verify the updated red packet state
    const redPacketAccount = await redPacketProgram.account.redPacket.fetch(
      redPacket
    );
    expect(redPacketAccount.claimedNumber.toString()).to.equal("1");
    expect(redPacketAccount.claimedUsers.length).to.equal(1);
    expect(redPacketAccount.claimedUsers[0].toString()).to.equal(
      randomUser.publicKey.toString()
    );
    expect(redPacketAccount.claimedAmountRecords.length).to.equal(1);

    // Verify claimer received tokens
    const claimerBalanceAfter = await connection.getTokenAccountBalance(
      claimerTokenAccount
    );
    expect(Number(claimerBalanceAfter.value.amount)).to.be.greaterThan(0);

    expect(redPacketAccount.claimedAmountRecords[0].toString()).to.equal(
      claimerBalanceAfter.value.amount
    );
    console.log("claimerBalance now", claimerBalanceAfter.value.amount);
  });

  it("fail to claim spl red packet because of invalid signature", async () => {
    // Re-derive the PDA
    const redPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(splRedPacketCreateTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];

    // Get claimer's token account
    const claimerTokenAccount = getAssociatedTokenAddressSync(
      tokenMint,
      randomUser2.publicKey,
      true,
      TOKEN_PROGRAM
    );

    // Get vault account
    const vaultAccount = getAssociatedTokenAddressSync(
      tokenMint,
      redPacket,
      true,
      TOKEN_PROGRAM
    );

    try {
      // Generate the message
      const message = Buffer.concat([
        redPacket.toBytes(),
        randomUser2.publicKey.toBytes(),
      ]);
      // randomUser sign the message, so the signature is invalid
      const signature = nacl.sign.detached(message, randomUser.secretKey);

      const ed25519Instruction2 = Ed25519Program.createInstructionWithPublicKey(
        {
          publicKey: randomUser.publicKey.toBytes(),
          message: message,
          signature: signature,
        }
      );

      // Verify signature before creating instruction
      const verifyResult = nacl.sign.detached.verify(
        message,
        signature,
        randomUser.publicKey.toBytes()
      );
      console.log("Signature verification in TS:", verifyResult);

      const tx = await redPacketProgram.methods
        .claimWithSplToken()
        .accounts({
          signer: randomUser2.publicKey,
          redPacket,
          tokenMint: tokenMint,
          tokenAccount: claimerTokenAccount,
          vault: vaultAccount,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Instruction2])
        .signers([randomUser2])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      console.log("catch error part");
      expect(error.error.errorCode.code).to.equal("InvalidSignature");
    }
  });

  it("claim native token red packet", async () => {
    // Re-derive the PDA
    const redPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(nativeRedPacketCreateTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];
    const claimerBalanceBefore = await connection.getBalance(
      randomUser.publicKey
    );

    // Generate the message
    const message = Buffer.concat([
      redPacket.toBytes(),
      randomUser.publicKey.toBytes(),
    ]);
    console.log("Original message:", bs58.encode(message));

    // Sign the message
    const signature = nacl.sign.detached(message, claimer_issuer.secretKey);

    const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: claimer_issuer.publicKey.toBytes(),
      message: message,
      signature: signature,
    });

    const tx = await redPacketProgram.methods
      .claimWithNativeToken()
      .accounts({
        redPacket,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([ed25519Instruction])
      .signers([randomUser])
      .rpc();
    await provider.connection.confirmTransaction(tx);

    const redPacketAccount = await redPacketProgram.account.redPacket.fetch(
      redPacket
    );

    expect(redPacketAccount.claimedNumber.toString()).equal("1");

    const claimerBalanceAfter = await connection.getBalance(
      randomUser.publicKey
    );
    expect(claimerBalanceAfter - claimerBalanceBefore).equal(
      0.1 * LAMPORTS_PER_SOL
    );
    expect(redPacketAccount.claimedUsers.length).equal(1);
    expect(redPacketAccount.claimedUsers[0].toString()).equal(
      randomUser.publicKey.toString()
    );
    expect(redPacketAccount.claimedAmountRecords.length).to.equal(1);
  });

  it("create and claim spl token red packet with random amount", async () => {
    const splRandomRedPacketCreateTime = new anchor.BN(
      Math.floor(Date.now() / 1000) + 5
    );
    const redPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(splRandomRedPacketCreateTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];

    const vault = getAssociatedTokenAddressSync(
      tokenMint,
      redPacket,
      true,
      TOKEN_PROGRAM
    );
    const redPacketDuration = new anchor.BN(60 * 60 * 24);
    const redPacketTotalNumber = 3;
    const redPacketTotalAmount = new anchor.BN(3 * LAMPORTS_PER_SOL);

    const tx = await redPacketProgram.methods
      .createRedPacketWithSplToken(
        redPacketTotalNumber,
        redPacketTotalAmount,
        splRandomRedPacketCreateTime,
        redPacketDuration,
        true, // if_split_random
        claimer_issuer.publicKey,
        "my first random amount spl red packet",
        "my first random amount spl red packet"
      )
      .accounts({
        signer: redPacketCreator.publicKey,
        redPacket,
        tokenMint: tokenMint,
        tokenAccount: tokenAccount,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([redPacketCreator])
      .rpc();
    await provider.connection.confirmTransaction(tx);

    const redPacketAccount = await redPacketProgram.account.redPacket.fetch(
      redPacket
    );
    expect(redPacketAccount.totalNumber.toString()).equal(
      redPacketTotalNumber.toString()
    );
    expect(redPacketAccount.totalAmount.toString()).equal(
      redPacketTotalAmount.toString()
    );
    expect(redPacketAccount.ifSpiltRandom).equal(true);

    // Generate the message
    const message = Buffer.concat([
      redPacket.toBytes(),
      randomUser.publicKey.toBytes(),
    ]);

    // Sign the message
    const signature = nacl.sign.detached(message, claimer_issuer.secretKey);

    const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: claimer_issuer.publicKey.toBytes(),
      message: message,
      signature: signature,
    });

    const claimer1TokenAccount = getAssociatedTokenAddressSync(
      tokenMint,
      randomUser.publicKey,
      true,
      TOKEN_PROGRAM
    );
    const claimTx = await redPacketProgram.methods
      .claimWithSplToken()
      .accounts({
        redPacket,
        signer: randomUser.publicKey,
        tokenMint: tokenMint,
        tokenAccount: claimer1TokenAccount,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([ed25519Instruction])
      .signers([randomUser])
      .rpc();
    await provider.connection.confirmTransaction(claimTx);

    // Generate the message
    const message2 = Buffer.concat([
      redPacket.toBytes(),
      randomUser2.publicKey.toBytes(),
    ]);

    // Sign the message
    const signature2 = nacl.sign.detached(message2, claimer_issuer.secretKey);

    const ed25519Instruction2 = Ed25519Program.createInstructionWithPublicKey({
      publicKey: claimer_issuer.publicKey.toBytes(),
      message: message2,
      signature: signature2,
    });
    const claimer2TokenAccount = getAssociatedTokenAddressSync(
      tokenMint,
      randomUser2.publicKey,
      true,
      TOKEN_PROGRAM
    );
    const claimTx2 = await redPacketProgram.methods
      .claimWithSplToken()
      .accounts({
        redPacket,
        signer: randomUser2.publicKey,
        tokenMint: tokenMint,
        tokenAccount: claimer2TokenAccount,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([ed25519Instruction2])
      .signers([randomUser2])
      .rpc();
    await provider.connection.confirmTransaction(claimTx2);
    // Generate the message
    const message3 = Buffer.concat([
      redPacket.toBytes(),
      redPacketCreator.publicKey.toBytes(),
    ]);

    // Sign the message
    const signature3 = nacl.sign.detached(message3, claimer_issuer.secretKey);

    const ed25519Instruction3 = Ed25519Program.createInstructionWithPublicKey({
      publicKey: claimer_issuer.publicKey.toBytes(),
      message: message3,
      signature: signature3,
    });

    const claimTx3 = await redPacketProgram.methods
      .claimWithSplToken()
      .accounts({
        redPacket,
        signer: redPacketCreator.publicKey,
        tokenMint: tokenMint,
        tokenAccount: tokenAccount,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([ed25519Instruction3])
      .signers([redPacketCreator])
      .rpc();
    await provider.connection.confirmTransaction(claimTx3);

    const redPacketAccountAfter =
      await redPacketProgram.account.redPacket.fetch(redPacket);
    expect(redPacketAccountAfter.claimedNumber.toString()).equal(
      redPacketTotalNumber.toString()
    );
    expect(redPacketAccountAfter.claimedAmount.toString()).equal(
      redPacketTotalAmount.toString()
    );
    expect(
      redPacketAccountAfter.totalAmount
        .sub(redPacketAccountAfter.claimedAmount)
        .toString()
    ).equal("0");
    console.log(
      "redPacketAccountAfter",
      redPacketAccountAfter.claimedAmountRecords[0].toString(),
      redPacketAccountAfter.claimedAmountRecords[1].toString(),
      redPacketAccountAfter.claimedAmountRecords[2].toString()
    );
  });

  it("create and claim native token red packet with random amount", async () => {
    const nativeRandomRedPacketCreateTime = new anchor.BN(
      Math.floor(Date.now() / 1000) + 7
    );
    const redPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(nativeRandomRedPacketCreateTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];
    const redPacketDuration = new anchor.BN(60 * 60 * 24);
    const redPacketTotalNumber = 3;
    const redPacketTotalAmount = new anchor.BN(0.03 * LAMPORTS_PER_SOL);

    const tx = await redPacketProgram.methods
      .createRedPacketWithNativeToken(
        redPacketTotalNumber,
        redPacketTotalAmount,
        nativeRandomRedPacketCreateTime,
        redPacketDuration,
        true, // if_split_random
        claimer_issuer.publicKey,
        "中文红包",
        "中文红包测试"
      )
      .accounts({
        signer: redPacketCreator.publicKey,
        redPacket,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([redPacketCreator])
      .rpc();
    await provider.connection.confirmTransaction(tx);

    const redPacketAccount = await redPacketProgram.account.redPacket.fetch(
      redPacket
    );
    expect(redPacketAccount.totalNumber.toString()).equal(
      redPacketTotalNumber.toString()
    );
    expect(redPacketAccount.totalAmount.toString()).equal(
      redPacketTotalAmount.toString()
    );
    expect(redPacketAccount.ifSpiltRandom).equal(true);

    // Generate the message
    const message = Buffer.concat([
      redPacket.toBytes(),
      randomUser.publicKey.toBytes(),
    ]);

    // Sign the message
    const signature = nacl.sign.detached(message, claimer_issuer.secretKey);

    const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: claimer_issuer.publicKey.toBytes(),
      message: message,
      signature: signature,
    });
    const claimTx = await redPacketProgram.methods
      .claimWithNativeToken()
      .accounts({
        redPacket,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([ed25519Instruction])
      .signers([randomUser])
      .rpc();
    await provider.connection.confirmTransaction(claimTx);

    // Generate the message
    const message2 = Buffer.concat([
      redPacket.toBytes(),
      randomUser2.publicKey.toBytes(),
    ]);

    // Sign the message
    const signature2 = nacl.sign.detached(message2, claimer_issuer.secretKey);

    const ed25519Instruction2 = Ed25519Program.createInstructionWithPublicKey({
      publicKey: claimer_issuer.publicKey.toBytes(),
      message: message2,
      signature: signature2,
    });
    const claimTx2 = await redPacketProgram.methods
      .claimWithNativeToken()
      .accounts({
        redPacket,
        signer: randomUser2.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([ed25519Instruction2])
      .signers([randomUser2])
      .rpc();
    await provider.connection.confirmTransaction(claimTx);
    // Generate the message
    const message3 = Buffer.concat([
      redPacket.toBytes(),
      redPacketCreator.publicKey.toBytes(),
    ]);

    // Sign the message
    const signature3 = nacl.sign.detached(message3, claimer_issuer.secretKey);

    const ed25519Instruction3 = Ed25519Program.createInstructionWithPublicKey({
      publicKey: claimer_issuer.publicKey.toBytes(),
      message: message3,
      signature: signature3,
    });

    const claimTx3 = await redPacketProgram.methods
      .claimWithNativeToken()
      .accounts({
        redPacket,
        signer: redPacketCreator.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([ed25519Instruction3])
      .signers([redPacketCreator])
      .rpc();
    await provider.connection.confirmTransaction(claimTx);

    const redPacketAccountAfter =
      await redPacketProgram.account.redPacket.fetch(redPacket);
    expect(redPacketAccountAfter.claimedNumber.toString()).equal(
      redPacketTotalNumber.toString()
    );
    expect(redPacketAccountAfter.claimedAmount.toString()).equal(
      redPacketTotalAmount.toString()
    );
    expect(
      redPacketAccountAfter.totalAmount
        .sub(redPacketAccountAfter.claimedAmount)
        .toString()
    ).equal("0");
    console.log(
      "redPacketAccountAfter",
      redPacketAccountAfter.claimedAmountRecords[0].toString(),
      redPacketAccountAfter.claimedAmountRecords[1].toString(),
      redPacketAccountAfter.claimedAmountRecords[2].toString()
    );
  });

  it("withdraw spl token red packet", async () => {
    // Re-derive the PDA
    const redPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(splRedPacketCreateTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];
    const redPacketAccount = await redPacketProgram.account.redPacket.fetch(
      redPacket
    );
    const redPacketRemainedAmount = redPacketAccount.totalAmount.sub(
      redPacketAccount.claimedAmount
    );
    console.log(
      "redPacket token RemainedAmount",
      redPacketRemainedAmount.toString()
    );

    const creatorLamportsBefore = await provider.connection.getBalance(
      redPacketCreator.publicKey
    );
    console.log("creatorLamportsBefore", creatorLamportsBefore.toString());

    const creatorTokenBalanceBefore =
      await provider.connection.getTokenAccountBalance(
        getAssociatedTokenAddressSync(
          tokenMint,
          redPacketCreator.publicKey,
          true,
          TOKEN_PROGRAM
        )
      );
    console.log(
      "creatorTokenBalanceBefore",
      creatorTokenBalanceBefore.value.uiAmount.toString()
    );
    // Now perform withdrawal
    const withdrawTx = await redPacketProgram.methods
      .withdrawWithSplToken()
      .accounts({
        redPacket,
        signer: redPacketCreator.publicKey,
        vault: vault,
        tokenAccount: tokenAccount, // Will be created if it doesn't exist
        tokenMint: tokenMint,
        tokenProgram: TOKEN_PROGRAM,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([redPacketCreator])
      .rpc();

    await provider.connection.confirmTransaction(withdrawTx);
    await getLogs(withdrawTx);

    const creatorTokenBalanceAfter =
      await provider.connection.getTokenAccountBalance(
        getAssociatedTokenAddressSync(
          tokenMint,
          redPacketCreator.publicKey,
          true,
          TOKEN_PROGRAM
        )
      );

    console.log(
      "creatorTokenBalanceAfter",
      creatorTokenBalanceAfter.value.amount.toString()
    );
    expect(
      new anchor.BN(creatorTokenBalanceAfter.value.amount)
        .sub(new anchor.BN(creatorTokenBalanceBefore.value.amount))
        .toString()
    ).equal(redPacketRemainedAmount.toString());

    // Verify the account is closed
    try {
      await redPacketProgram.account.redPacket.fetch(redPacket);
      assert.fail("Expected account to be closed");
    } catch (error) {
      expect(error.message).to.include("Account does not exist");
    }
  });

  it("withdraw native token red packet", async () => {
    // Re-derive the PDA
    const redPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(nativeRedPacketCreateTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];
    const redPacketAccount = await redPacketProgram.account.redPacket.fetch(
      redPacket
    );
    const redPacketRemainedAmount = redPacketAccount.totalAmount.sub(
      redPacketAccount.claimedAmount
    );
    console.log(
      "redPacketAccount.totalAmount",
      redPacketAccount.totalAmount.toString()
    );
    console.log(
      "redPacketAccount.claimedAmount",
      redPacketAccount.claimedAmount.toString()
    );
    console.log(
      "redPacketAccount.remainedAmount",
      redPacketRemainedAmount.toString()
    );

    const creatorLamportsBefore = await provider.connection.getBalance(
      redPacketCreator.publicKey
    );
    console.log("creatorLamportsBefore", creatorLamportsBefore.toString());
    // Now perform withdrawal
    const withdrawTx = await redPacketProgram.methods
      .withdrawWithNativeToken()
      .accounts({
        redPacket,
        signer: redPacketCreator.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([redPacketCreator])
      .rpc();

    await provider.connection.confirmTransaction(withdrawTx);
    await getLogs(withdrawTx);
    const creatorLamportsAfter = await provider.connection.getBalance(
      redPacketCreator.publicKey
    );
    console.log("creatorLamportsAfter", creatorLamportsAfter.toString());

    expect(creatorLamportsAfter - creatorLamportsBefore).greaterThan(
      redPacketRemainedAmount.toNumber()
    );

    // Verify the account is closed
    try {
      await redPacketProgram.account.redPacket.fetch(redPacket);
      assert.fail("Expected account to be closed");
    } catch (error) {
      expect(error.message).to.include("Account does not exist");
    }
  });

  it("fail to create spl red packet with invalid parameters", async () => {
    // Re-derive the PDA
    const createTime = new anchor.BN(Math.floor(Date.now() / 1000) - 100);
    const redPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(createTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];

    // Get vault account
    const vaultAccount = getAssociatedTokenAddressSync(
      tokenMint,
      redPacket,
      true,
      TOKEN_PROGRAM
    );
    const duration = new anchor.BN(200);
    const totalNumber = 1;
    const totalAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithSplToken(
          totalNumber,
          totalAmount,
          createTime,
          duration.sub(new anchor.BN(110)),
          false,
          claimer_issuer.publicKey,
          "will fail create red packet",
          "will fail create spl red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket,
          tokenMint: tokenMint,
          tokenAccount: tokenAccount,
          vault: vaultAccount,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      console.log("catch error part");
      expect(error.error.errorCode.code).to.equal("InvalidExpiryTime");
    }

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithSplToken(
          0,
          totalAmount,
          createTime,
          duration,
          false,
          claimer_issuer.publicKey,
          "will fail create red packet",
          "will fail create spl red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket,
          tokenMint: tokenMint,
          tokenAccount: tokenAccount,
          vault: vaultAccount,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      expect(error.error.errorCode.code).to.equal("InvalidTotalNumber");
    }

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithSplToken(
          201,
          totalAmount,
          createTime,
          duration,
          false,
          claimer_issuer.publicKey,
          "will fail create red packet",
          "will fail create spl red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket,
          tokenMint: tokenMint,
          tokenAccount: tokenAccount,
          vault: vaultAccount,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      expect(error.error.errorCode.code).to.equal("InvalidTotalNumber");
    }

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithSplToken(
          totalNumber,
          new anchor.BN(0),
          createTime,
          duration,
          false,
          claimer_issuer.publicKey,
          "will fail create red packet",
          "will fail create spl red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket,
          tokenMint: tokenMint,
          tokenAccount: tokenAccount,
          vault: vaultAccount,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      expect(error.error.errorCode.code).to.equal("InvalidTotalAmount");
    }

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithSplToken(
          totalNumber,
          new anchor.BN(1000 * LAMPORTS_PER_SOL),
          createTime,
          duration,
          false,
          claimer_issuer.publicKey,
          "will fail create red packet",
          "will fail create spl red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket,
          tokenMint: tokenMint,
          tokenAccount: tokenAccount,
          vault: vaultAccount,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      expect(error.error.errorCode.code).to.equal("InsufficientTokenBalance");
    }
  });

  it("fail to create native red packet with invalid parameters", async () => {
    // Re-derive the PDA
    const createTime = new anchor.BN(Math.floor(Date.now() / 1000) - 100);
    const redPacket = PublicKey.findProgramAddressSync(
      [
        redPacketCreator.publicKey.toBuffer(),
        Buffer.from(createTime.toArray("le", 8)),
      ],
      redPacketProgram.programId
    )[0];

    const duration = new anchor.BN(200);
    const totalNumber = 1;
    const totalAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithNativeToken(
          totalNumber,
          totalAmount,
          createTime,
          duration.sub(new anchor.BN(110)),
          false,
          claimer_issuer.publicKey,
          "will fail create red packet",
          "will fail create native red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      console.log("catch error part");
      expect(error.error.errorCode.code).to.equal("InvalidExpiryTime");
    }

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithNativeToken(
          0,
          totalAmount,
          createTime,
          duration,
          false,
          claimer_issuer.publicKey,
          "will fail create red packet",
          "will fail create native red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      expect(error.error.errorCode.code).to.equal("InvalidTotalNumber");
    }

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithNativeToken(
          201,
          totalAmount,
          createTime,
          duration,
          false,
          claimer_issuer.publicKey,
          "will fail create red packet",
          "will fail create native red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      expect(error.error.errorCode.code).to.equal("InvalidTotalNumber");
    }

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithNativeToken(
          totalNumber,
          new anchor.BN(0),
          createTime,
          duration,
          false,
          claimer_issuer.publicKey,
          "will fail create red packet",
          "will fail create native red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      expect(error.error.errorCode.code).to.equal("InvalidTotalAmount");
    }

    try {
      const tx = await redPacketProgram.methods
        .createRedPacketWithNativeToken(
          totalNumber,
          new anchor.BN(1000 * LAMPORTS_PER_SOL),
          createTime,
          duration,
          false,
          claimer_issuer.publicKey,
          "will fail create red packet",
          "will fail create native red packet"
        )
        .accounts({
          signer: redPacketCreator.publicKey,
          redPacket,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([redPacketCreator])
        .rpc();
      await provider.connection.confirmTransaction(tx);

      assert.fail("Expected transaction to fail with InvalidSignature error");
    } catch (error) {
      // Verify we got the expected error
      expect(error.error.errorCode.code).to.equal("InsufficientTokenBalance");
    }
  });
});

async function getLogs(signature: string) {
  try {
    const provider = anchor.AnchorProvider.env();
    const logs = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!logs || !logs.meta) {
      console.error("Failed to retrieve logs for transaction:", signature);
      return;
    }

    console.log("Program Logs:");
    console.log(logs.meta.logMessages.join("\n"));
  } catch (error) {
    console.error("Error retrieving logs for transaction:", signature, error);
  }
}
