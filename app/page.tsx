"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import bs58 from "bs58"
import { Connection, PublicKey } from "@solana/web3.js"

type VaultEntry = { pubkey: string; hasSecret: boolean; sk?: string }

interface TokenInfo {
  name?: string
  symbol?: string
  source?: "jup" | "pump" | "unknown"
}

const RPC_ENDPOINTS = [
  "https://solana-mainnet.core.chainstack.com/1dddd2834b79c0f3f43138bd4a45e3eb",
  "https://api.mainnet-beta.solana.com",
  "https://solana-api.projectserum.com",
]

function createConnectionWithAuth(endpoint: string) {
  const config: any = { commitment: "confirmed" }
  return new Connection(endpoint, config)
}

export default function Home() {
  const [currentRpcIndex, setCurrentRpcIndex] = useState(0)
  const [connection, setConnection] = useState(() => createConnectionWithAuth(RPC_ENDPOINTS[0]))
  const [rpcOk, setRpcOk] = useState<boolean | null>(null)
  const [rpcLatency, setRpcLatency] = useState<number | null>(null)

  const [vaultKeys, setVaultKeys] = useState<string>("")
  const [connected, setConnected] = useState<VaultEntry[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [balancesLoading, setBalancesLoading] = useState(false)

  const [mintRaw, setMintRaw] = useState<string>("")
  const mint = useMemo(() => sanitizeMintInput(mintRaw), [mintRaw])
  const [token, setToken] = useState<TokenInfo>({})

  const [activeTab, setActiveTab] = useState<"buy" | "sell">("buy")
  const [buyPerc, setBuyPerc] = useState<number>(50)
  const [sellPerc, setSellPerc] = useState<number>(100)
  const [slippageBps, setSlippageBps] = useState<number>(5000)

  const [loading, setLoading] = useState(false)
  const [log, setLog] = useState<string>("")

  const [transactionResults, setTransactionResults] = useState<{
    successful: Array<{ wallet: string; signature?: string; amount?: number }>
    failed: Array<{ wallet: string; error: string; amount?: number }>
  }>({ successful: [], failed: [] })

  const refreshId = useRef(0)

  useEffect(() => {
    let mounted = true
    let retryCount = 0

    const checkRpcHealth = async () => {
      try {
        const startTime = Date.now()
        await connection.getLatestBlockhash("confirmed")
        const latency = Date.now() - startTime

        if (mounted) {
          setRpcOk(true)
          setRpcLatency(latency)
          retryCount = 0 // Reset retry count on success
        }
      } catch (error: any) {
        console.error(`[v0] RPC health check failed for ${RPC_ENDPOINTS[currentRpcIndex]}:`, error)

        if (mounted && retryCount < RPC_ENDPOINTS.length - 1) {
          // Try next RPC endpoint
          retryCount++
          const nextIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length
          console.log(`[v0] Switching to RPC endpoint ${nextIndex}: ${RPC_ENDPOINTS[nextIndex]}`)

          setCurrentRpcIndex(nextIndex)
          setConnection(createConnectionWithAuth(RPC_ENDPOINTS[nextIndex]))

          // Retry with new endpoint after short delay
          setTimeout(() => {
            if (mounted) checkRpcHealth()
          }, 1000)
        } else if (mounted) {
          setRpcOk(false)
          setRpcLatency(null)
        }
      }
    }

    checkRpcHealth()

    // Check RPC health every 30 seconds
    const interval = setInterval(checkRpcHealth, 30000)

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [connection, currentRpcIndex])

  async function addVault() {
    const lines = vaultKeys
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    const items: VaultEntry[] = []
    for (const line of lines) {
      try {
        const { Keypair } = await import("@solana/web3.js")
        let kp
        if (line.startsWith("[")) {
          const arr = Uint8Array.from(JSON.parse(line))
          kp = Keypair.fromSecretKey(arr)
        } else {
          const secret = bs58.decode(line)
          kp = Keypair.fromSecretKey(secret)
        }
        items.push({ pubkey: kp.publicKey.toBase58(), hasSecret: true, sk: line })
      } catch {
        // ignore invalid entries
      }
    }

    const map = new Map<string, VaultEntry>()
    for (const w of [...connected, ...items]) map.set(w.pubkey, w)
    const next = Array.from(map.values()).slice(0, 120)
    setConnected(next)

    const sel: Record<string, boolean> = { ...selected }
    next.forEach((w) => (sel[w.pubkey] = true))
    setSelected(sel)
    setVaultKeys("")
  }

  async function resolveTokenMeta(mintAddr: string) {
    try {
      setToken({})
      if (!mintAddr) return
      const j = await fetch("https://token.jup.ag/all").then((r) => r.json())
      const found = (j as any[]).find((t: any) => t.address === mintAddr)
      if (found) return setToken({ name: found.name, symbol: found.symbol, source: "jup" })

      const p = await fetch(`https://frontend-api.pump.fun/coins/${mintAddr}`).then((r) => (r.ok ? r.json() : null))
      if (p && p.symbol) return setToken({ name: p.name, symbol: p.symbol, source: "pump" })

      setToken({ name: undefined, symbol: undefined, source: "unknown" })
    } catch {
      setToken({ source: "unknown" })
    }
  }

  useEffect(() => {
    if (mint) void resolveTokenMeta(mint)
  }, [mint])

  async function refreshBalances() {
    const cur = ++refreshId.current
    const pubkeys = connected.map((w) => w.pubkey)
    if (pubkeys.length === 0) {
      setBalances({})
      return
    }
    setBalancesLoading(true)
    try {
      const next: Record<string, number> = {}
      const chunkSize = 99
      for (let i = 0; i < pubkeys.length; i += chunkSize) {
        const slice = pubkeys.slice(i, i + chunkSize)
        const infos = await connection.getMultipleAccountsInfo(
          slice.map((s) => new PublicKey(s)),
          { commitment: "confirmed" },
        )
        infos.forEach((info, idx) => {
          const key = slice[idx]
          const lamports = info?.lamports ?? 0
          next[key] = lamports / 1e9
        })
        if (cur !== refreshId.current) return
      }
      if (cur === refreshId.current) setBalances(next)
    } finally {
      if (cur === refreshId.current) setBalancesLoading(false)
    }
  }

  useEffect(() => {
    void refreshBalances()
  }, [connected, connection])

  function toggleAll(v: boolean) {
    const s: Record<string, boolean> = {}
    connected.forEach((w) => (s[w.pubkey] = v))
    setSelected(s)
  }

  const playBuySuccessSound = () => {
    try {
      const audio = new Audio(
        "https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Apple%20Pay%20sound%20effect-Y8Lva1pUiq0AXmNZMcNJvPv5OKtv5A.mp3",
      )
      audio.volume = 0.3
      audio.play().catch(console.error)
    } catch (error) {
      console.error("Failed to play buy success sound:", error)
    }
  }

  async function buy() {
    setLoading(true)
    setTransactionResults({ successful: [], failed: [] })
    setLog(`🚀 Ultra-fast sniping with ${connected.length} wallets simultaneously...`)

    try {
      const selectedWallets = connected.filter((w) => selected[w.pubkey] && w.hasSecret)

      if (selectedWallets.length === 0) {
        setLog("❌ Error: No wallets selected")
        return
      }

      const buyPromises = selectedWallets.map(async (wallet) => {
        const balance = balances[wallet.pubkey] || 0
        const buyAmount = (balance * buyPerc) / 100 - 0.005 // Reserve minimal SOL for fees

        if (buyAmount <= 0) {
          return { wallet: wallet.pubkey, error: "Insufficient balance", amount: 0 }
        }

        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 8000) // Ultra-fast 8s timeout

          const res = await fetch("/api/buy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            signal: controller.signal,
            body: JSON.stringify({
              privateKey: wallet.sk,
              tokenMint: mint,
              amount: buyAmount,
              slippage: Math.max(slippageBps / 100, 50),
              priorityFee: 0.01, // Higher priority fee for faster execution
            }),
          })

          clearTimeout(timeoutId)
          const result = await res.json()

          return {
            wallet: wallet.pubkey,
            success: result.success,
            signature: result.signature,
            error: result.error,
            amount: buyAmount,
          }
        } catch (e: any) {
          return {
            wallet: wallet.pubkey,
            error: e.name === "AbortError" ? "Timeout (8s)" : e.message,
            amount: buyAmount,
          }
        }
      })

      const results = await Promise.allSettled(buyPromises)
      const processedResults = results.map((r) =>
        r.status === "fulfilled" ? r.value : { wallet: "unknown", error: "Promise failed", amount: 0 },
      )

      const successful = processedResults.filter((r) => r.success)
      const failed = processedResults.filter((r) => !r.success)

      setTransactionResults({ successful, failed })

      const summary = {
        mint,
        totalWallets: selectedWallets.length,
        successful: successful.length,
        failed: failed.length,
        successRate: `${((successful.length / selectedWallets.length) * 100).toFixed(1)}%`,
        totalAmount: successful.reduce((sum, r) => sum + (r.amount || 0), 0).toFixed(4),
      }

      setLog(JSON.stringify(summary, null, 2))

      if (successful.length > 0) {
        playBuySuccessSound()
      }
    } catch (e: any) {
      setLog(`❌ Critical Error: ${e?.message || String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  async function sell() {
    setLoading(true)
    setTransactionResults({ successful: [], failed: [] })
    setLog(`💰 Ultra-fast sell executing with ${connected.length} wallets...`)

    try {
      const selectedWallets = connected.filter((w) => selected[w.pubkey] && w.hasSecret)

      if (selectedWallets.length === 0) {
        setLog("❌ Error: No wallets selected")
        return
      }

      const sellPromises = selectedWallets.map(async (wallet) => {
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 8000) // Ultra-fast 8s timeout

          const res = await fetch("/api/sell", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            signal: controller.signal,
            body: JSON.stringify({
              mint,
              privateKeys: [wallet.sk],
              percentage: sellPerc,
              slippageBps,
              priorityFee: 0.01, // Higher priority fee
            }),
          })

          clearTimeout(timeoutId)
          const result = await res.json()

          return {
            wallet: wallet.pubkey,
            success: result.success || (result.ok && result.ok.length > 0),
            signature: result.signature || (result.ok && result.ok[0]),
            error: result.error || (result.fail && result.fail[0]?.error),
          }
        } catch (e: any) {
          return {
            wallet: wallet.pubkey,
            error: e.name === "AbortError" ? "Timeout (8s)" : e.message,
          }
        }
      })

      const results = await Promise.allSettled(sellPromises)
      const processedResults = results.map((r) =>
        r.status === "fulfilled" ? r.value : { wallet: "unknown", error: "Promise failed" },
      )

      const successful = processedResults.filter((r) => r.success)
      const failed = processedResults.filter((r) => !r.success)

      setTransactionResults({ successful, failed })

      const summary = {
        mint,
        totalWallets: selectedWallets.length,
        successful: successful.length,
        failed: failed.length,
        successRate: `${((successful.length / selectedWallets.length) * 100).toFixed(1)}%`,
      }

      setLog(JSON.stringify(summary, null, 2))
    } catch (e: any) {
      setLog(`❌ Critical Error: ${e?.message || String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  const selectedCount = useMemo(() => Object.values(selected).filter(Boolean).length, [selected])
  const totalSelectedSol = useMemo(
    () =>
      connected.reduce((acc, w) => {
        if (!selected[w.pubkey]) return acc
        return acc + (balances[w.pubkey] ?? 0)
      }, 0),
    [connected, selected, balances],
  )
  const totalVaultSol = useMemo(
    () => connected.reduce((acc, w) => acc + (balances[w.pubkey] ?? 0), 0),
    [connected, balances],
  )

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Solana Sniper · 65 Wallets</h1>
          <p className="text-slate-400 text-sm">Paste keys, pick mint, execute ultra-fast buy/sell.</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm">
          <span className="text-slate-400">RPC: </span>
          <span className={rpcOk ? "text-emerald-400" : rpcOk === false ? "text-rose-400" : "text-slate-400"}>
            {rpcOk == null
              ? "Checking..."
              : rpcOk
                ? `Connected ${getRpcProviderName(RPC_ENDPOINTS[currentRpcIndex])}${rpcLatency ? ` (${rpcLatency}ms)` : ""}`
                : "Disconnected"}
          </span>
        </div>
      </header>

      <section className="grid md:grid-cols-2 gap-6">
        <div className="card space-y-3">
          <h2 className="font-semibold">1) Connect wallets (local vault)</h2>
          <textarea
            className="input min-h-[140px] font-mono"
            placeholder="One base58 or JSON secret array per line"
            value={vaultKeys}
            onChange={(e) => setVaultKeys(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={() => addVault()}>
              Add to vault
            </button>
            <button
              className="btn bg-slate-700 hover:bg-slate-600"
              onClick={() => {
                setConnected([])
                setSelected({})
                setBalances({})
              }}
            >
              Clear
            </button>
            <button className="btn bg-slate-700 hover:bg-slate-600" onClick={() => toggleAll(true)}>
              Select all
            </button>
            <button className="btn bg-slate-700 hover:bg-slate-600" onClick={() => toggleAll(false)}>
              Unselect all
            </button>
            <button
              className="btn bg-indigo-700 hover:bg-indigo-600"
              onClick={() => refreshBalances()}
              disabled={balancesLoading}
            >
              {balancesLoading ? "Refreshing…" : "Refresh balances"}
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm text-slate-300">
            <div>Vault wallets: {connected.length}</div>
            <div>Selected: {selectedCount}</div>
            <div>
              Selected SOL: <span className="font-mono text-white">{totalSelectedSol.toFixed(4)} SOL</span>
            </div>
            <div>
              Total SOL: <span className="font-mono text-white">{totalVaultSol.toFixed(4)} SOL</span>
            </div>
          </div>

          <div className="max-h-72 overflow-auto border border-slate-800 rounded-xl p-2">
            {connected.length === 0 ? (
              <p className="text-slate-400 text-sm">No vault wallets yet.</p>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-emerald-400 border-b border-emerald-800 pb-1">
                    ✅ Successful ({transactionResults.successful.length})
                  </h4>
                  <ul className="space-y-1 text-xs">
                    {transactionResults.successful.map((result) => {
                      const wallet = connected.find((w) => w.pubkey === result.wallet)
                      const bal = balances[result.wallet]
                      return (
                        <li key={result.wallet} className="bg-emerald-900/20 border border-emerald-800 rounded p-2">
                          <div className="flex items-center gap-2 mb-1">
                            <input
                              type="checkbox"
                              checked={!!selected[result.wallet]}
                              onChange={(e) => setSelected({ ...selected, [result.wallet]: e.target.checked })}
                            />
                            <span className="font-mono text-emerald-300">{result.wallet.slice(0, 8)}...</span>
                          </div>
                          <div className="text-emerald-400 text-xs">
                            {bal != null && `${bal.toFixed(4)} SOL`}
                            {result.signature && (
                              <div className="text-emerald-300">✓ {result.signature.slice(0, 8)}...</div>
                            )}
                          </div>
                        </li>
                      )
                    })}
                    {transactionResults.successful.length === 0 &&
                      transactionResults.failed.length === 0 &&
                      connected.map((w) => {
                        const bal = balances[w.pubkey]
                        return (
                          <li key={w.pubkey} className="flex items-center justify-between gap-2 p-1">
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={!!selected[w.pubkey]}
                                onChange={(e) => setSelected({ ...selected, [w.pubkey]: e.target.checked })}
                              />
                              <span className="font-mono text-xs">{w.pubkey.slice(0, 12)}...</span>
                            </label>
                            <div className="flex items-center gap-2 text-xs">
                              <span className="font-mono">{bal == null ? "…" : `${bal.toFixed(4)} SOL`}</span>
                              <span className={w.hasSecret ? "text-emerald-400" : "text-yellow-400"}>
                                {w.hasSecret ? "🔑" : "👁"}
                              </span>
                            </div>
                          </li>
                        )
                      })}
                  </ul>
                </div>

                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-red-400 border-b border-red-800 pb-1">
                    ❌ Failed ({transactionResults.failed.length})
                  </h4>
                  <ul className="space-y-1 text-xs">
                    {transactionResults.failed.map((result) => {
                      const wallet = connected.find((w) => w.pubkey === result.wallet)
                      const bal = balances[result.wallet]
                      return (
                        <li key={result.wallet} className="bg-red-900/20 border border-red-800 rounded p-2">
                          <div className="flex items-center gap-2 mb-1">
                            <input
                              type="checkbox"
                              checked={!!selected[result.wallet]}
                              onChange={(e) => setSelected({ ...selected, [result.wallet]: e.target.checked })}
                            />
                            <span className="font-mono text-red-300">{result.wallet.slice(0, 8)}...</span>
                          </div>
                          <div className="text-red-400 text-xs">
                            {bal != null && `${bal.toFixed(4)} SOL`}
                            <div className="text-red-300">❌ {result.error}</div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card space-y-3">
          <h2 className="font-semibold">2) Pick token</h2>
          <input
            className="input"
            placeholder="Paste mint address or pump.fun URL (supports fresh tokens)"
            value={mintRaw}
            onChange={(e) => setMintRaw(e.target.value)}
          />
          <div className="text-xs text-slate-400">
            Using mint: <span className="text-white font-mono">{mint || "—"}</span>
          </div>

          <div className="text-sm text-slate-300">
            {token.name ? (
              <p>
                Resolved: <span className="text-white font-semibold">{token.name}</span>{" "}
                {token.symbol ? `(${token.symbol})` : ""} <span className="text-slate-400">via {token.source}</span>
              </p>
            ) : (
              <p>We try Jupiter first, then Pump.fun metadata.</p>
            )}
          </div>

          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setActiveTab("buy")}
              className={`btn flex-1 ${activeTab === "buy" ? "bg-blue-600 hover:bg-blue-500" : "bg-slate-700 hover:bg-slate-600"}`}
            >
              🚀 BUY
            </button>
            <button
              onClick={() => setActiveTab("sell")}
              className={`btn flex-1 ${activeTab === "sell" ? "bg-orange-600 hover:bg-orange-500" : "bg-slate-700 hover:bg-slate-600"}`}
            >
              💰 SELL
            </button>
          </div>

          <label className="block text-xs text-slate-400 mt-2">
            Slippage (bps):
            <input
              className="input mt-1"
              type="number"
              min={100}
              step={100}
              value={slippageBps}
              onChange={(e) => setSlippageBps(Math.max(100, Number(e.target.value || 0)))}
            />
          </label>
          <p className="text-xs text-slate-400">
            {slippageBps >= 5000
              ? "🚀 HIGH SLIPPAGE: Perfect for fresh tokens with low liquidity"
              : "2000 bps = 20%. Higher slippage = faster fills on new launches."}
          </p>

          {activeTab === "buy" ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="block text-xs text-slate-400">Buy percentage of SOL balance:</label>
                <div className="grid grid-cols-5 gap-2">
                  <button
                    onClick={() => setBuyPerc(25)}
                    className={`btn text-xs py-2 ${buyPerc === 25 ? "bg-blue-600 hover:bg-blue-500" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    25%
                  </button>
                  <button
                    onClick={() => setBuyPerc(50)}
                    className={`btn text-xs py-2 ${buyPerc === 50 ? "bg-blue-600 hover:bg-blue-500" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    50%
                  </button>
                  <button
                    onClick={() => setBuyPerc(75)}
                    className={`btn text-xs py-2 ${buyPerc === 75 ? "bg-blue-600 hover:bg-blue-500" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    75%
                  </button>
                  <button
                    onClick={() => setBuyPerc(95)}
                    className={`btn text-xs py-2 ${buyPerc === 95 ? "bg-red-700 hover:bg-red-600" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    95%
                  </button>
                  <button
                    onClick={() => setBuyPerc(100)}
                    className={`btn text-xs py-2 ${buyPerc === 100 ? "bg-red-800 hover:bg-red-700" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    100%
                  </button>
                </div>
                <div className="text-xs text-slate-400">Selected: {buyPerc}% of available SOL balance</div>
              </div>
              <button
                className="btn w-full bg-blue-600 hover:bg-blue-500"
                disabled={loading || !mint || Object.values(selected).every((v) => !v)}
                onClick={buy}
              >
                {loading ? "🚀 Sniping..." : "🚀 SNIPE BUY"}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="block text-xs text-slate-400">Sell percentage of token balance:</label>
                <div className="grid grid-cols-5 gap-2">
                  <button
                    onClick={() => setSellPerc(25)}
                    className={`btn text-xs py-2 ${sellPerc === 25 ? "bg-orange-600 hover:bg-orange-500" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    25%
                  </button>
                  <button
                    onClick={() => setSellPerc(50)}
                    className={`btn text-xs py-2 ${sellPerc === 50 ? "bg-orange-600 hover:bg-orange-500" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    50%
                  </button>
                  <button
                    onClick={() => setSellPerc(75)}
                    className={`btn text-xs py-2 ${sellPerc === 75 ? "bg-orange-600 hover:bg-orange-500" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    75%
                  </button>
                  <button
                    onClick={() => setSellPerc(95)}
                    className={`btn text-xs py-2 ${sellPerc === 95 ? "bg-red-700 hover:bg-red-600" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    95%
                  </button>
                  <button
                    onClick={() => setSellPerc(100)}
                    className={`btn text-xs py-2 ${sellPerc === 100 ? "bg-red-800 hover:bg-red-700" : "bg-slate-700 hover:bg-slate-600"}`}
                  >
                    100%
                  </button>
                </div>
                <div className="text-xs text-slate-400">Selected: {sellPerc}% of available token balance</div>
              </div>
              <button
                className="btn w-full bg-orange-600 hover:bg-orange-500"
                disabled={loading || !mint || Object.values(selected).every((v) => !v)}
                onClick={sell}
              >
                {loading ? "💰 Selling..." : "💰 SELL"}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-2">Run output</h2>
        <pre className="text-xs whitespace-pre-wrap">{log}</pre>
      </section>
    </div>
  )
}

function sanitizeMintInput(input: string): string {
  const s = input.trim()
  if (!s) return ""
  try {
    if (s.startsWith("http")) {
      const url = new URL(s)
      const mintParam = url.searchParams.get("mint")
      if (mintParam) return sanitizeMintInput(mintParam)
      const parts = url.pathname.split("/").filter(Boolean)
      const coinIdx = parts.findIndex((p) => p.toLowerCase() === "coin" || p.toLowerCase() === "coins")
      if (coinIdx >= 0 && parts[coinIdx + 1]) return sanitizeMintInput(parts[coinIdx + 1])
    }
  } catch {}
  return s.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "")
}

function getRpcProviderName(endpoint: string): string {
  if (endpoint.includes("chainstack")) return "Chainstack"
  if (endpoint.includes("alchemy.com")) return "Alchemy"
  if (endpoint.includes("mainnet-beta.solana.com")) return "Solana"
  if (endpoint.includes("projectserum")) return "Serum"
  return "Custom"
}
