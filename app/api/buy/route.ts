import { type NextRequest, NextResponse } from "next/server"
import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js"
import bs58 from "bs58"
import { PublicKey, SystemProgram, TransactionMessage, ComputeBudgetProgram } from "@solana/web3.js"
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token"

const JUPITER_API_BASE = "https://quote-api.jup.ag/v6"
const JUPITER_API_KEY = "2f280df-aa16-4c78-979c-6468f660dbfb"

const RPC_ENDPOINTS = [
  "https://solana-mainnet.core.chainstack.com/1dddd2834b79c0f3f43138bd4a45e3eb",
  "https://mainnet.helius-rpc.com/?api-key=785c7d18-85fe-4925-b949-50e533aec16e",
  "https://rpc.helius.xyz/?api-key=785c7d18-85fe-4925-b949-50e533aec16e",
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
]

async function createConnectionWithRetry(): Promise<Connection> {
  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    try {
      const connection = new Connection(RPC_ENDPOINTS[i], {
        commitment: "processed",
        confirmTransactionInitialTimeout: 15000,
      })

      // Test the connection with a quick call
      await connection.getSlot()
      console.log(`✅ Connected to RPC endpoint ${i + 1}: ${RPC_ENDPOINTS[i].split("/")[2]}`)
      return connection
    } catch (error: any) {
      console.log(`⚠️ RPC endpoint ${i + 1} failed: ${error.message}`)
      if (i === RPC_ENDPOINTS.length - 1) {
        throw new Error("All RPC endpoints failed")
      }
    }
  }
  throw new Error("No RPC endpoints available")
}

async function withRpcRetry<T>(operation: (connection: Connection) => Promise<T>): Promise<T> {
  let lastError: Error | null = null

  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    try {
      const connection = new Connection(RPC_ENDPOINTS[i], {
        commitment: "processed",
        confirmTransactionInitialTimeout: 15000,
      })

      return await operation(connection)
    } catch (error: any) {
      lastError = error
      console.log(`⚠️ RPC ${i + 1} failed: ${error.message}`)

      // If it's a rate limit error, try next endpoint immediately
      if (error.message?.includes("429") || error.message?.includes("max usage reached")) {
        console.log(`🔄 Rate limited on RPC ${i + 1}, switching to next endpoint...`)
        continue
      }

      // For other errors, also try next endpoint
      if (i < RPC_ENDPOINTS.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500)) // Brief delay
        continue
      }
    }
  }

  throw lastError || new Error("All RPC endpoints failed")
}

// Pump.fun program constants
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
const PUMP_FUN_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf")
const PUMP_FUN_FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM")

interface BuyRequest {
  privateKey: string
  tokenMint: string
  amount: number
  slippage?: number
}

export async function POST(request: NextRequest) {
  try {
    const body: BuyRequest = await request.json()
    const { privateKey, tokenMint, amount, slippage = 50 } = body

    console.log(`🚀 BUY API: ${amount} SOL for token ${tokenMint}`)

    // Validate inputs
    if (!privateKey || !tokenMint || !amount) {
      return NextResponse.json({ success: false, error: "Missing required parameters" }, { status: 400 })
    }

    if (amount <= 0 || amount > 10) {
      return NextResponse.json({ success: false, error: "Invalid amount" }, { status: 400 })
    }

    // Create keypair from private key
    let keypair: Keypair
    try {
      const cleanKey = privateKey.trim()

      if (cleanKey.includes(",")) {
        // Array format
        const numbers = cleanKey.split(",").map((n) => Number.parseInt(n.trim()))
        if (numbers.length !== 64 || numbers.some((n) => isNaN(n) || n < 0 || n > 255)) {
          throw new Error("Invalid array format")
        }
        keypair = Keypair.fromSecretKey(new Uint8Array(numbers))
      } else if (cleanKey.length === 128) {
        // Hex format
        const bytes = new Uint8Array(64)
        for (let i = 0; i < 64; i++) {
          bytes[i] = Number.parseInt(cleanKey.substr(i * 2, 2), 16)
        }
        keypair = Keypair.fromSecretKey(bytes)
      } else {
        // Base58 format
        const decoded = bs58.decode(cleanKey)
        if (decoded.length !== 64) {
          throw new Error("Invalid key length")
        }
        keypair = Keypair.fromSecretKey(decoded)
      }
    } catch (error) {
      console.error("❌ Invalid private key format:", error)
      return NextResponse.json({ success: false, error: "Invalid private key format" }, { status: 400 })
    }

    console.log(`💰 Wallet: ${keypair.publicKey.toString()}`)

    const { balance, connection } = await withRpcRetry(async (conn) => {
      const bal = await conn.getBalance(keypair.publicKey)
      return { balance: bal, connection: conn }
    })

    const balanceSOL = balance / LAMPORTS_PER_SOL

    console.log(`💰 Balance: ${balanceSOL} SOL`)

    if (balanceSOL < amount + 0.01) {
      return NextResponse.json(
        {
          success: false,
          error: `Insufficient balance: ${balanceSOL.toFixed(4)} SOL available, need ${(amount + 0.01).toFixed(4)} SOL`,
        },
        { status: 400 },
      )
    }

    const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL)
    const slippageBps = Math.max(slippage * 100, 5000) // Minimum 50% slippage for fresh tokens

    console.log(`⚡ Step 1: Trying Jupiter first...`)

    // Step 1: Try Jupiter first
    try {
      const quoteUrl = `${JUPITER_API_BASE}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenMint}&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false`

      const quoteResponse = await fetch(quoteUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-API-Key": JUPITER_API_KEY,
        },
      })

      if (quoteResponse.ok) {
        const quoteData = await quoteResponse.json()

        if (quoteData && !quoteData.error && quoteData.outAmount && quoteData.outAmount !== "0") {
          // Jupiter route available - proceed with existing logic
          console.log(`✅ Jupiter route found, proceeding with swap...`)

          const outputTokens = Number.parseInt(quoteData.outAmount) / Math.pow(10, 6)
          console.log(`✅ Quote OK: Will receive ~${outputTokens.toFixed(2)} tokens`)

          const swapPayload = {
            quoteResponse: quoteData,
            userPublicKey: keypair.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: "auto",
            skipUserAccountsRpcCalls: true,
            asLegacyTransaction: false,
            useTokenLedger: false,
            destinationTokenAccount: undefined,
            dynamicComputeUnitLimit: true,
          }

          const swapResponse = await fetch(`${JUPITER_API_BASE}/swap`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": JUPITER_API_KEY,
            },
            body: JSON.stringify(swapPayload),
          })

          if (swapResponse.ok) {
            const swapData = await swapResponse.json()

            if (swapData.swapTransaction) {
              const swapTransactionBuf = Buffer.from(swapData.swapTransaction, "base64")
              const transaction = VersionedTransaction.deserialize(swapTransactionBuf)
              transaction.sign([keypair])

              const signature = await connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: true,
                preflightCommitment: "processed",
                maxRetries: 0,
              })

              const confirmation = await connection.confirmTransaction(signature, "processed")

              if (!confirmation.value.err) {
                console.log(`🎉 JUPITER BUY SUCCESS!`)
                return NextResponse.json({
                  success: true,
                  signature,
                  outputTokens: outputTokens.toFixed(2),
                  solscanUrl: `https://solscan.io/tx/${signature}`,
                  message: `Successfully bought ~${outputTokens.toFixed(2)} tokens for ${amount} SOL via Jupiter`,
                })
              }
            }
          }
        }
      }
    } catch (jupiterError) {
      console.log(`⚠️ Jupiter failed, trying direct Pump.fun...`)
    }

    console.log(`⚡ Step 2: Direct Pump.fun contract interaction...`)

    try {
      const result = await withRpcRetry(async (conn) => {
        // Calculate minimum tokens out with high slippage tolerance
        const minTokensOut = 1 // Very low minimum for fresh tokens

        // Create buy instruction for Pump.fun
        const tokenMintPubkey = new PublicKey(tokenMint)

        // Correct PDA derivations for Pump.fun
        const [bondingCurve] = PublicKey.findProgramAddressSync(
          [Buffer.from("bonding-curve"), tokenMintPubkey.toBuffer()],
          PUMP_FUN_PROGRAM,
        )

        const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
          [bondingCurve.toBuffer(), tokenMintPubkey.toBuffer(), Buffer.from("associated-token-account")],
          PUMP_FUN_PROGRAM,
        )

        // Get user's associated token account
        const userTokenAccount = await getAssociatedTokenAddress(tokenMintPubkey, keypair.publicKey)

        // Check if accounts exist
        const [bondingCurveInfo, userTokenAccountInfo] = await Promise.all([
          conn.getAccountInfo(bondingCurve),
          conn.getAccountInfo(userTokenAccount),
        ])

        if (!bondingCurveInfo) {
          throw new Error("Token bonding curve not found - token may not be a valid Pump.fun token")
        }

        const instructions = []

        // Add high priority compute budget
        instructions.push(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 200000, // Higher priority for fresh tokens
          }),
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 300000, // Higher compute limit
          }),
        )

        // Create associated token account if needed
        if (!userTokenAccountInfo) {
          instructions.push(
            createAssociatedTokenAccountInstruction(
              keypair.publicKey,
              userTokenAccount,
              keypair.publicKey,
              tokenMintPubkey,
            ),
          )
        }

        // Correct Pump.fun buy instruction
        const buyInstructionData = Buffer.alloc(24)
        buyInstructionData.writeUInt32LE(0x66063d12, 0) // Buy method discriminator
        buyInstructionData.writeBigUInt64LE(BigInt(amountLamports), 8) // SOL amount
        buyInstructionData.writeBigUInt64LE(BigInt(1), 16) // Min tokens out (very low for fresh tokens)

        const buyInstruction = {
          programId: PUMP_FUN_PROGRAM,
          keys: [
            { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: tokenMintPubkey, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: buyInstructionData,
        }

        instructions.push(buyInstruction)

        // Create transaction with recent blockhash
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("finalized")

        const messageV0 = new TransactionMessage({
          payerKey: keypair.publicKey,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message()

        const transaction = new VersionedTransaction(messageV0)
        transaction.sign([keypair])

        console.log(`📡 Sending direct Pump.fun transaction...`)

        // Send with higher commitment and retries for fresh tokens
        const signature = await conn.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false, // Enable preflight for better error messages
          preflightCommitment: "processed",
          maxRetries: 2,
        })

        console.log(`📡 Transaction sent: ${signature}`)

        // Wait for confirmation with timeout
        const confirmation = (await Promise.race([
          conn.confirmTransaction(
            {
              signature,
              blockhash,
              lastValidBlockHeight,
            },
            "processed",
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction confirmation timeout")), 20000)),
        ])) as any

        if (confirmation.value?.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`)
        }

        return { signature, connection: conn }
      })

      console.log(`🎉 DIRECT PUMP.FUN BUY SUCCESS!`)
      return NextResponse.json({
        success: true,
        signature: result.signature,
        solscanUrl: `https://solscan.io/tx/${result.signature}`,
        message: `Successfully bought fresh token for ${amount} SOL via direct Pump.fun contract`,
      })
    } catch (directError: any) {
      console.error(`❌ Direct Pump.fun buy failed:`, directError)

      // Provide more specific error messages
      let errorMessage = directError.message || "Unknown error"
      if (errorMessage.includes("insufficient funds")) {
        errorMessage = "Insufficient SOL balance for transaction"
      } else if (errorMessage.includes("blockhash not found")) {
        errorMessage = "Network congestion - try again"
      } else if (errorMessage.includes("InvalidAccountData")) {
        errorMessage = "Token may not be a valid Pump.fun token"
      } else if (errorMessage.includes("429") || errorMessage.includes("max usage reached")) {
        errorMessage = "All RPC endpoints are rate limited - please try again in a few minutes"
      }

      return NextResponse.json(
        {
          success: false,
          error: `Direct Pump.fun transaction failed: ${errorMessage}`,
        },
        { status: 500 },
      )
    }
  } catch (error: any) {
    console.error("❌ API Buy error:", error)

    let errorMessage = error.message || "Unknown error occurred"
    if (errorMessage.includes("429") || errorMessage.includes("max usage reached")) {
      errorMessage = "All RPC endpoints are currently rate limited. Please try again in a few minutes."
    }

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 },
    )
  }
}
