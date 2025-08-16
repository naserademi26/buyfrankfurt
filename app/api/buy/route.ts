import { type NextRequest, NextResponse } from "next/server"
import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js"
import bs58 from "bs58"
import { PublicKey, SystemProgram, TransactionMessage, ComputeBudgetProgram } from "@solana/web3.js"
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token"

const JUPITER_API_BASE = "https://quote-api.jup.ag/v6"
const JUPITER_API_KEY = "2f280df-aa16-4c78-979c-6468f660dbfb"

const RPC_ENDPOINTS = [
  "https://mainnet.helius-rpc.com/?api-key=785c7d18-85fe-4925-b949-50e533aec16e",
  "https://anitra-p4zjjp-fast-mainnet.helius-rpc.com",
  "https://api.mainnet-beta.solana.com",
]

const FAST_RPC_ENDPOINTS = [
  "https://mainnet.helius-rpc.com/?api-key=785c7d18-85fe-4925-b949-50e533aec16e",
  "https://anitra-p4zjjp-fast-mainnet.helius-rpc.com",
  "https://api.mainnet-beta.solana.com",
]

const REBATE_ADDRESS = "8nNna3Jghj5qYGizorFkLGYdpsDKM1Fyzgfq4RUycHpN"

async function createConnectionWithFailover(): Promise<Connection> {
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const connection = new Connection(endpoint, {
        commitment: "processed",
        confirmTransactionInitialTimeout: 3000,
      })

      await Promise.race([
        connection.getSlot(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Health check timeout")), 800)),
      ])

      console.log(`✅ Connected to RPC: ${endpoint}`)
      return connection
    } catch (error: any) {
      console.log(`⚠️ RPC ${endpoint} failed: ${error.message}`)
      continue
    }
  }
  throw new Error("All RPC endpoints failed")
}

async function executeWithRPCFailover<T>(operation: (connection: Connection) => Promise<T>): Promise<T> {
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const connection = new Connection(endpoint, {
        commitment: "processed",
        confirmTransactionInitialTimeout: 3000,
      })

      return await operation(connection)
    } catch (error) {
      if (error.message?.includes("429") || error.code === 429) {
        console.log(`⚠️ Rate limited on ${endpoint}, switching immediately...`)
        continue
      }

      if (RPC_ENDPOINTS.indexOf(endpoint) === RPC_ENDPOINTS.length - 1) {
        throw error
      }

      console.log(`⚠️ ${endpoint} failed: ${error.message}, trying next...`)
    }
  }
  throw new Error("All RPC endpoints exhausted")
}

async function createLightningConnection(): Promise<Connection[]> {
  const validEndpoints = FAST_RPC_ENDPOINTS.filter((endpoint) => {
    try {
      const url = new URL(endpoint)
      return url.protocol === "https:" || url.protocol === "http:"
    } catch {
      console.log(`⚠️ Invalid RPC endpoint URL: ${endpoint}`)
      return false
    }
  })

  if (validEndpoints.length === 0) {
    throw new Error("No valid RPC endpoints available for lightning transactions")
  }

  const connections = validEndpoints.map(
    (endpoint) =>
      new Connection(endpoint, {
        commitment: "processed",
        confirmTransactionInitialTimeout: 2000,
        wsEndpoint: undefined,
      }),
  )
  return connections
}

async function submitTransactionLightning(transaction: VersionedTransaction): Promise<string> {
  try {
    const connections = await createLightningConnection()

    const submissions = connections.map(async (connection, index) => {
      try {
        const signature = await Promise.race([
          connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: true,
            preflightCommitment: "processed",
            maxRetries: 0,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Lightning submission timeout")), 1000)),
        ])
        console.log(`⚡ Lightning submission ${index + 1} sent: ${signature}`)
        return signature as string
      } catch (error) {
        console.log(`⚠️ Fast endpoint ${index + 1} failed: ${error.message}`)
        throw error
      }
    })

    return await Promise.any(submissions)
  } catch (error) {
    console.log(`⚠️ All lightning endpoints failed: ${error.message}`)
    throw new Error(`Lightning transaction failed: ${error.message}`)
  }
}

async function getLightningBalance(publicKey: PublicKey): Promise<number> {
  try {
    const connections = await createLightningConnection()

    const balanceChecks = connections.map((connection) =>
      Promise.race([
        connection.getBalance(publicKey),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Lightning balance timeout")), 500)),
      ]),
    )

    return (await Promise.any(balanceChecks)) as number
  } catch (error) {
    console.log(`⚠️ Lightning balance check failed: ${error.message}`)
    throw error
  }
}

async function getLightningBlockhash() {
  try {
    const connections = await createLightningConnection()

    const blockhashRequests = connections.map((connection) =>
      Promise.race([
        connection.getLatestBlockhash("processed"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Blockhash timeout")), 500)),
      ]),
    )

    return await Promise.any(blockhashRequests)
  } catch (error) {
    console.log(`⚠️ Lightning blockhash failed: ${error.message}`)
    throw error
  }
}

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

    if (!privateKey || !tokenMint || !amount) {
      return NextResponse.json({ success: false, error: "Missing required parameters" }, { status: 400 })
    }

    if (amount <= 0 || amount > 10) {
      return NextResponse.json(
        { success: false, error: "Invalid amount (must be between 0 and 10 SOL)" },
        { status: 400 },
      )
    }

    try {
      new PublicKey(tokenMint)
    } catch {
      return NextResponse.json({ success: false, error: "Invalid token mint address format" }, { status: 400 })
    }

    let keypair: Keypair
    try {
      const cleanKey = privateKey.trim()

      if (cleanKey.includes(",")) {
        const numbers = cleanKey.split(",").map((n) => Number.parseInt(n.trim()))
        if (numbers.length !== 64 || numbers.some((n) => isNaN(n) || n < 0 || n > 255)) {
          throw new Error("Invalid array format")
        }
        keypair = Keypair.fromSecretKey(new Uint8Array(numbers))
      } else if (cleanKey.length === 128) {
        const bytes = new Uint8Array(64)
        for (let i = 0; i < 64; i++) {
          bytes[i] = Number.parseInt(cleanKey.substr(i * 2, 2), 16)
        }
        keypair = Keypair.fromSecretKey(bytes)
      } else {
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

    const balance = await executeWithRPCFailover(async (connection) => {
      return (await Promise.race([
        connection.getBalance(keypair.publicKey),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Balance check timeout")), 1500)),
      ])) as number
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
    const slippageBps = Math.max(slippage * 100, 5000)

    console.log(`⚡ Step 1: Trying Jupiter first...`)

    try {
      const quoteUrl = `${JUPITER_API_BASE}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenMint}&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false`

      const quoteResponse = (await Promise.race([
        fetch(quoteUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-API-Key": JUPITER_API_KEY,
          },
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Jupiter quote timeout")), 1500)),
      ])) as Response

      if (quoteResponse.ok) {
        const quoteData = await quoteResponse.json()

        if (quoteData && !quoteData.error && quoteData.outAmount && quoteData.outAmount !== "0") {
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

          const swapResponse = (await Promise.race([
            fetch(`${JUPITER_API_BASE}/swap`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-API-Key": JUPITER_API_KEY,
              },
              body: JSON.stringify(swapPayload),
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Jupiter swap timeout")), 1500)),
          ])) as Response

          if (swapResponse.ok) {
            const swapData = await swapResponse.json()

            if (swapData.swapTransaction) {
              const result = await executeWithRPCFailover(async (connection) => {
                const swapTransactionBuf = Buffer.from(swapData.swapTransaction, "base64")
                const transaction = VersionedTransaction.deserialize(swapTransactionBuf)
                transaction.sign([keypair])

                const signature = await connection.sendRawTransaction(transaction.serialize(), {
                  skipPreflight: true,
                  preflightCommitment: "processed",
                  maxRetries: 0,
                })

                const confirmation = (await Promise.race([
                  connection.confirmTransaction(signature, "processed"),
                  new Promise((_, reject) => setTimeout(() => reject(new Error("Confirmation timeout")), 2000)),
                ])) as any

                if (!confirmation.value?.err) {
                  return { signature, outputTokens }
                }
                throw new Error("Transaction failed")
              })

              console.log(`🎉 JUPITER BUY SUCCESS!`)
              return NextResponse.json({
                success: true,
                signature: result.signature,
                outputTokens: result.outputTokens.toFixed(2),
                solscanUrl: `https://solscan.io/tx/${result.signature}`,
                message: `Successfully bought ~${result.outputTokens.toFixed(2)} tokens for ${amount} SOL via Jupiter`,
              })
            }
          }
        }
      }
    } catch (jupiterError) {
      console.log(`⚠️ Jupiter failed: ${jupiterError.message}, trying direct Pump.fun...`)
    }

    console.log(`⚡ Step 2: Direct Pump.fun contract interaction...`)

    const result = await executeWithRPCFailover(async (connection) => {
      const tokenMintPubkey = new PublicKey(tokenMint)

      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), tokenMintPubkey.toBuffer()],
        PUMP_FUN_PROGRAM,
      )

      const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
        [bondingCurve.toBuffer(), tokenMintPubkey.toBuffer(), Buffer.from("associated-token-account")],
        PUMP_FUN_PROGRAM,
      )

      const userTokenAccount = await getAssociatedTokenAddress(tokenMintPubkey, keypair.publicKey)

      const [bondingCurveInfo, userTokenAccountInfo] = (await Promise.race([
        Promise.all([connection.getAccountInfo(bondingCurve), connection.getAccountInfo(userTokenAccount)]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Account info timeout")), 2000)),
      ])) as any

      if (!bondingCurveInfo) {
        throw new Error("Token bonding curve not found - token may not be a valid Pump.fun token")
      }

      const instructions = []

      instructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 200000,
        }),
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 300000,
        }),
      )

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

      const buyInstructionData = Buffer.alloc(24)
      buyInstructionData.writeUInt32LE(0x66063d12, 0)
      buyInstructionData.writeBigUInt64LE(BigInt(amountLamports), 8)
      buyInstructionData.writeBigUInt64LE(BigInt(1), 16)

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

      const { blockhash, lastValidBlockHeight } = (await Promise.race([
        connection.getLatestBlockhash("finalized"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Blockhash timeout")), 2000)),
      ])) as any

      const messageV0 = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message()

      const transaction = new VersionedTransaction(messageV0)
      transaction.sign([keypair])

      console.log(`📡 Sending direct Pump.fun transaction...`)

      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: "processed",
        maxRetries: 0,
      })

      console.log(`📡 Transaction sent: ${signature}`)

      const confirmation = (await Promise.race([
        connection.confirmTransaction(
          {
            signature,
            blockhash,
            lastValidBlockHeight,
          },
          "processed",
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction confirmation timeout")), 3000)),
      ])) as any

      if (confirmation.value?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`)
      }

      return signature
    })

    console.log(`🎉 DIRECT PUMP.FUN BUY SUCCESS!`)
    return NextResponse.json({
      success: true,
      signature: result,
      solscanUrl: `https://solscan.io/tx/${result}`,
      message: `Successfully bought fresh token for ${amount} SOL via direct Pump.fun contract`,
    })
  } catch (error: any) {
    console.error("❌ API Buy error:", error)

    let errorMessage = error.message || "Unknown error occurred"
    if (errorMessage.includes("429") || error.code === 429) {
      errorMessage = "RPC endpoint rate limited. Switching to backup endpoint..."
    } else if (errorMessage.includes("403")) {
      errorMessage = "RPC endpoint access denied. Using alternative endpoint..."
    } else if (errorMessage.includes("Failed to fetch")) {
      errorMessage = "Network connection failed. Please check your internet connection."
    } else if (errorMessage.includes("Endpoint URL must start with")) {
      errorMessage = "Invalid RPC endpoint configuration. Please contact support."
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

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
const PUMP_FUN_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf")
const PUMP_FUN_FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM")
