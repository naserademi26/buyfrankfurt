"use client"

import { createContext, useContext, useState, useCallback, type ReactNode } from "react"
import { Connection } from "@solana/web3.js"

export const RPC_ENDPOINTS = [
  "https://lb.drpc.org/solana/AoLSJPx3VEsDmDDks2UasTR-g70MeVMR8Is_IgaNGuYu",
  "https://solana-mainnet.core.chainstack.com/1dddd2834b79c0f3f43138bd4a45e3eb",
  "https://api.mainnet-beta.solana.com",
  "https://solana-api.projectserum.com",
  "https://rpc.ankr.com/solana",
]

const DRPC_API_TOKEN = "cc41c7e9dbbb70e05b92558fe0699ec61f30bd40198747e770d321ed9f5f61c7"

interface WalletContextType {
  connection: Connection
  currentRPC: string
  switchRPC: (rpcUrl: string) => void
  getFastestConnection: () => Connection
}

const WalletContext = createContext<WalletContextType | undefined>(undefined)

interface WalletProviderProps {
  children: ReactNode
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [currentRPC, setCurrentRPC] = useState(RPC_ENDPOINTS[0])
  const [connection, setConnection] = useState(
    () =>
      new Connection(RPC_ENDPOINTS[0], {
        commitment: "processed",
        confirmTransactionInitialTimeout: 8000,
        wsEndpoint: undefined,
        disableRetryOnRateLimit: false,
        httpHeaders: {
          Authorization: `Bearer ${DRPC_API_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "PumpFunSniperBot/4.0",
          "Cache-Control": "no-cache",
        },
      }),
  )

  const switchRPC = useCallback((rpcUrl: string) => {
    console.log(`🔄 Switching to RPC: ${rpcUrl}`)
    const headers: any = {
      "Content-Type": "application/json",
      "User-Agent": "PumpFunSniperBot/4.0",
      "Cache-Control": "no-cache",
    }

    if (rpcUrl.includes("drpc.org")) {
      headers.Authorization = `Bearer ${DRPC_API_TOKEN}`
    }

    const newConnection = new Connection(rpcUrl, {
      commitment: "processed",
      confirmTransactionInitialTimeout: 8000,
      wsEndpoint: undefined,
      disableRetryOnRateLimit: false,
      httpHeaders: headers,
    })
    setConnection(newConnection)
    setCurrentRPC(rpcUrl)
  }, [])

  const getFastestConnection = useCallback(() => {
    const headers: any = {
      "Content-Type": "application/json",
      "User-Agent": "PumpFunSniperBot/4.0",
      "Cache-Control": "no-cache",
    }

    if (RPC_ENDPOINTS[0].includes("drpc.org")) {
      headers.Authorization = `Bearer ${DRPC_API_TOKEN}`
    }

    return new Connection(RPC_ENDPOINTS[0], {
      commitment: "processed",
      confirmTransactionInitialTimeout: 6000,
      wsEndpoint: undefined,
      disableRetryOnRateLimit: false,
      httpHeaders: headers,
    })
  }, [])

  return (
    <WalletContext.Provider value={{ connection, currentRPC, switchRPC, getFastestConnection }}>
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  const context = useContext(WalletContext)
  if (context === undefined) {
    throw new Error("useWallet must be used within a WalletProvider")
  }
  return context
}
