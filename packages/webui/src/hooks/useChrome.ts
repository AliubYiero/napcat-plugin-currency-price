import { useCallback, useEffect, useState } from 'react'
import { noAuthFetch } from '../utils/api'
import type { BrowserStatus, InstallState } from '../types'

/** 状态轮询间隔。与 `App.tsx` 的 `/status` 轮询同频 */
const POLL_INTERVAL_MS = 5000

/**
 * 浏览器状态与安装动作。
 *
 * ⚠️ 轮询走的是 `/chrome/status`，它**只读缓存、零副作用**。绝不能在这里调
 * `/chrome/detect`——那会起一个浏览器进程，而这个 hook 每 5 秒跑一次。
 */
export function useChrome() {
    const [status, setStatus] = useState<BrowserStatus | null>(null)
    const [install, setInstall] = useState<InstallState | null>(null)
    const [busy, setBusy] = useState(false)

    const fetchStatus = useCallback(async () => {
        try {
            const data = await noAuthFetch<BrowserStatus>('/chrome/status')
            if (data.code === 0 && data.data) setStatus(data.data)
        } catch (e) {
            console.error('Chrome status fetch failed:', e)
        }
    }, [])

    const fetchProgress = useCallback(async () => {
        try {
            const data = await noAuthFetch<InstallState>('/chrome/install/progress')
            if (data.code === 0 && data.data) setInstall(data.data)
        } catch (e) {
            console.error('Chrome install progress fetch failed:', e)
        }
    }, [])

    useEffect(() => {
        fetchStatus()
        const interval = setInterval(fetchStatus, POLL_INTERVAL_MS)
        return () => clearInterval(interval)
    }, [fetchStatus])

    // 安装进行中时才轮询进度：装完了就没必要继续问
    useEffect(() => {
        if (!install?.running) return
        const interval = setInterval(fetchProgress, 1000)
        return () => clearInterval(interval)
    }, [install?.running, fetchProgress])

    /** 显式触发一次完整检测（起来一个浏览器验证），比轮询重得多 */
    const detect = useCallback(async () => {
        setBusy(true)
        try {
            const data = await noAuthFetch<BrowserStatus>('/chrome/detect', { method: 'POST' })
            if (data.code === 0 && data.data) setStatus(data.data)
        } finally {
            setBusy(false)
        }
    }, [])

    /** 触发下载安装。后端后台跑，进度靠轮询 */
    const startInstall = useCallback(async () => {
        setBusy(true)
        try {
            await noAuthFetch('/chrome/install', { method: 'POST' })
            await fetchProgress()
        } finally {
            setBusy(false)
        }
    }, [fetchProgress])

    return { status, install, busy, detect, startInstall, refresh: fetchStatus }
}
