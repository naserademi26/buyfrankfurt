import { NextResponse } from "next/server"
import { Connection } from "@solana/web3.js"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const DRPC_RPC_URL = "https://lb.drpc.org/solana/AoLSJPx3VEsDmDDks2UasTR-g70MeVMR8Is_IgaNGuYu"
const DRPC_API_TOKEN = "cc41c7e9dbbb70e05b92558fe0699ec61f30bd40198747e770d321ed9f5f61c7"

const BXR_REGION = process.env.BLOXROUTE_REGION_URL || "https://ny.solana.dex.blxrbdn.com"
const BXR_SUBMIT = process.env.BLOXROUTE_SUBMIT_URL || "https://global.solana.dex.blxrbdn.com"

const JUP_BASE = process.env.JUP_BASE || "https://api.jup.ag"
const JUP_API_KEY = process.env.JUP_API_KEY || process.env.JUPITER_API_KEY || "2f280df-aa16-4c78-979c-6468f660dbfb"

export async function GET() {
  const out: any = {}

  // RPC test
  try {
    const conn = new Connection(DRPC_RPC_URL, {
      commitment: "confirmed",
      httpHeaders: {
        Authorization: `Bearer ${DRPC_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    })
    const bh = await conn.getLatestBlockhash("confirmed")
    out.rpc = { ok: true, lastValidBlockHeight: bh.lastValidBlockHeight }
  } catch (e: any) {
    out.rpc = { ok: false, error: e?.message || String(e) }
  }

  // Jupiter quote test (SOL->SOL minimal amount just to check reachability)
  try {
    const url = `${JUP_BASE}/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=So11111111111111111111111111111111111111112&amount=1000&slippageBps=10`
    const res = await fetch(url, { headers: { "X-API-Key": JUP_API_KEY, Accept: "application/json" } })
    out.jupiter = { ok: res.ok, status: res.status }
  } catch (e: any) {
    out.jupiter = { ok: false, error: e?.message || String(e) }
  }

  // bloXroute reachability (GET home should return non-network error or 200/4xx)
  try {
    const resRegion = await fetch(BXR_REGION, { method: "GET" })
    const resSubmit = await fetch(BXR_SUBMIT, { method: "GET" })
    out.bloxroute = {
      regionReachable: true,
      regionStatus: resRegion.status,
      submitReachable: true,
      submitStatus: resSubmit.status,
    }
  } catch (e: any) {
    out.bloxroute = { reachable: false, error: e?.message || String(e) }
  }

  return NextResponse.json(out)
}
