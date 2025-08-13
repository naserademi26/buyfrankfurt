import { type NextRequest, NextResponse } from "next/server"

const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY
const BITQUERY_ENDPOINT = "https://streaming.bitquery.io/graphql"

const NEW_TOKEN_QUERY = `
query NewPumpTokens {
  Solana {
    TokenSupplyUpdates(
      where: {
        Instruction: {
          Program: {Address: {is: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"}}
          Method: {is: "create"}
        }
        Block: {Time: {since: "2024-01-01"}}
      }
      orderBy: {descending: Block_Time}
      limit: 10
    ) {
      Block {
        Time
        Height
      }
      Transaction {
        Signer
        Hash
      }
      TokenSupplyUpdate {
        Amount
        PostBalance
        Currency {
          Symbol
          Name
          MintAddress
          Decimals
          Uri
          Native
          Fungible
          PrimarySaleHappened
        }
      }
    }
  }
}
`

// Store active monitoring sessions
const activeMonitors = new Map<string, NodeJS.Timeout>()

const processedTokens = new Set<string>()

export async function POST(request: NextRequest) {
  try {
    if (!BITQUERY_API_KEY) {
      return NextResponse.json({ error: "BITQUERY_API_KEY not configured" }, { status: 500 })
    }

    const { action, privateKeys, buyPercentage = 25, autoSnipe = false } = await request.json()

    if (action === "start") {
      // Start monitoring for new tokens
      const monitorId = `monitor_${Date.now()}`

      const monitor = setInterval(async () => {
        try {
          const response = await fetch(BITQUERY_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${BITQUERY_API_KEY}`,
            },
            body: JSON.stringify({
              query: NEW_TOKEN_QUERY,
            }),
          })

          if (!response.ok) {
            console.error("Bitquery API error:", response.status, response.statusText)
            return
          }

          const data = await response.json()
          const newTokens = data?.data?.Solana?.TokenSupplyUpdates || []

          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
          const recentTokens = newTokens.filter((tokenUpdate: any) => {
            const blockTime = new Date(tokenUpdate.Block.Time).getTime()
            return blockTime > fiveMinutesAgo
          })

          // Process ultra-fresh tokens
          for (const tokenUpdate of recentTokens) {
            const currency = tokenUpdate.TokenSupplyUpdate.Currency
            const mintAddress = currency.MintAddress
            const symbol = currency.Symbol || "Unknown"
            const name = currency.Name || "Unknown Token"
            const blockTime = tokenUpdate.Block.Time

            if (processedTokens.has(mintAddress)) continue
            processedTokens.add(mintAddress)

            console.log(`🚀 ULTRA-FRESH TOKEN DETECTED: ${symbol} (${name}) - ${mintAddress}`)
            console.log(`⏰ Created at: ${blockTime}`)

            if (autoSnipe && privateKeys && privateKeys.length > 0) {
              try {
                console.log(`🎯 EXECUTING FIRST-BUYER SNIPE for ${symbol}...`)

                const buyResponse = await fetch("/api/snipe", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    mint: mintAddress,
                    privateKeys,
                    percentage: buyPercentage,
                    limitWallets: 65,
                    slippageBps: 5000, // Higher slippage for fresh tokens
                  }),
                })

                const buyResult = await buyResponse.json()
                console.log(
                  `🎯 FIRST-BUYER SNIPE RESULT for ${symbol}: ${buyResult.success}/${buyResult.wallets} successful`,
                )

                if (buyResult.success > 0) {
                  console.log(`✅ SUCCESSFULLY SNIPED FRESH TOKEN: ${symbol} with ${buyResult.success} wallets`)
                } else {
                  console.log(`❌ FAILED TO SNIPE FRESH TOKEN: ${symbol} - ${buyResult.error || "Unknown error"}`)
                }
              } catch (error) {
                console.error(`❌ FIRST-BUYER SNIPE FAILED for ${symbol}:`, error)
              }
            }
          }
        } catch (error) {
          console.error("Ultra-fresh token monitoring error:", error)
        }
      }, 1000) // Check every 1 second for maximum speed

      activeMonitors.set(monitorId, monitor)

      return NextResponse.json({
        success: true,
        monitorId,
        message: "Token monitoring started",
        autoSnipe: autoSnipe ? "enabled" : "disabled",
      })
    }

    if (action === "stop") {
      const { monitorId } = await request.json()

      if (monitorId && activeMonitors.has(monitorId)) {
        clearInterval(activeMonitors.get(monitorId))
        activeMonitors.delete(monitorId)
        return NextResponse.json({ success: true, message: "Token monitoring stopped" })
      }

      // Stop all monitors if no specific ID provided
      activeMonitors.forEach((monitor) => clearInterval(monitor))
      activeMonitors.clear()

      return NextResponse.json({ success: true, message: "All token monitoring stopped" })
    }

    if (action === "status") {
      return NextResponse.json({
        activeMonitors: activeMonitors.size,
        monitoring: activeMonitors.size > 0,
      })
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  } catch (error) {
    console.error("Monitor new tokens error:", error)
    return NextResponse.json(
      {
        error: "Failed to process token monitoring request",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}

export async function GET() {
  return NextResponse.json({
    activeMonitors: activeMonitors.size,
    monitoring: activeMonitors.size > 0,
    endpoint: "Token monitoring status",
  })
}
