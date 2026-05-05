import { NextRequest, NextResponse } from 'next/server';
import {
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  Keypair,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction } from '@solana/spl-token';
import bs58 from 'bs58';
import { env } from 'process';

// Load environment variables
const RPC_URL = env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PLATFORM_PRIVATE_KEY = env.PLATFORM_PRIVATE_KEY;
const PLATFORM_WALLET_ADDRESS = env.PLATFORM_WALLET_ADDRESS;
const SOLANA_USDC_MINT = env.SOLANA_USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

// Convert private key string to Keypair
const getKeypairFromPrivateKey = (privateKeyString: string): Keypair => {
  let secretKey: Uint8Array;
  
  // Try parsing as JSON array first
  if (privateKeyString.startsWith('[') && privateKeyString.endsWith(']')) {
    secretKey = Uint8Array.from(JSON.parse(privateKeyString));
  } else {
    // Assume it's base58 encoded (common for Solana wallets)
    // Convert base58 string to Uint8Array
    const decoded = bs58.decode(privateKeyString);
    secretKey = Uint8Array.from(decoded);
  }
  
  return Keypair.fromSecretKey(secretKey);
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { recipients } = body;

    // Validate request
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        { error: 'Recipients array is required and must not be empty' },
        { status: 400 }
      );
    }

    // Validate each recipient has address and amount
    for (const recipient of recipients) {
      if (!recipient.address || !recipient.amount) {
        return NextResponse.json(
          { error: 'Each recipient must have "address" and "amount" fields' },
          { status: 400 }
        );
      }
    }

    // Connect to Solana network
    const connection = new Connection(RPC_URL, 'confirmed');

    // Test connection first using getSlot
    const slot = await connection.getSlot();
    if (slot === 0) {
      return NextResponse.json(
        { error: 'Failed to connect to Solana network' },
        { status: 503 }
      );
    }

    // Validate private key exists
    if (!PLATFORM_PRIVATE_KEY || !PLATFORM_WALLET_ADDRESS) {
      return NextResponse.json(
        { error: 'PLATFORM_PRIVATE_KEY and PLATFORM_WALLET_ADDRESS environment variables are required' },
        { status: 500 }
      );
    }

    // Get platform wallet keypair
    const keypair = getKeypairFromPrivateKey(PLATFORM_PRIVATE_KEY);
    const platformWallet = new PublicKey(PLATFORM_WALLET_ADDRESS);

    // Get USDC token account address
    const usdcMint = new PublicKey(SOLANA_USDC_MINT);
    const platformTokenAccount = await getAssociatedTokenAddress(usdcMint, platformWallet);

    // Verify token account exists
    const tokenAccountInfo = await connection.getTokenAccountBalance(platformTokenAccount);
    if (!tokenAccountInfo.value) {
      return NextResponse.json(
        { error: 'Platform wallet does not have a USDC token account or insufficient balance' },
        { status: 400 }
      );
    }

    // Create transaction with multiple transfers
    const transaction = new Transaction();

    for (const recipient of recipients) {
      const recipientAddress = new PublicKey(recipient.address);
      const recipientTokenAccount = await getAssociatedTokenAddress(usdcMint, recipientAddress);

      // Create transfer instruction for USDC (amount is in USDC decimals, typically 6)
      const transferAmount = Math.floor(recipient.amount * 1_000_000); // Convert to lamports

      const transferInstruction = createTransferInstruction(
        platformTokenAccount,
        recipientTokenAccount,
        platformWallet,
        transferAmount
      );

      transaction.add(transferInstruction);
    }

    // Send and confirm transaction
    const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);

    return NextResponse.json(
      {
        success: true,
        message: 'USDC sent to multiple wallets successfully',
        signature,
        recipientsSent: recipients.length,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('Error sending USDC:', error);
    
    // Try to parse error message if it's a JSON response
    let errorMessage = error.message;
    if (error.details) {
      try {
        const parsed = JSON.parse(error.details);
        errorMessage = JSON.stringify(parsed);
      } catch {
        errorMessage = error.details;
      }
    }
    
    return NextResponse.json(
      { error: 'Failed to send USDC', details: errorMessage, stack: process.env.NODE_ENV === 'development' ? error.stack : undefined },
      { status: 500 }
    );
  }
}
