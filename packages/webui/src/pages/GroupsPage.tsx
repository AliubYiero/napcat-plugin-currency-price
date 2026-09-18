import { useState, useEffect, useCallback } from 'react'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import type { GroupInfo, SessionMap } from '../types'
import { IconSearch, IconRefresh, IconGroup, IconCheck, IconX } from '../components/icons'

/**
 * 会话键 → 展示用的类型与号码。
 *
 * 无法识别的形态**原样显示整个键**，不猜也不吞——它是排查问题时唯一的线索。
 */
function parseSessionKey(key: string): { kind: 'group' | 'private' | 'other'; id: string } {
    const idx = key.indexOf(':')
    if (idx < 0) return { kind: 'other', id: key }

    const prefix = key.slice(0, idx)
    const id = key.slice(idx + 1)

    if (prefix === 'group') return { kind: 'group', id }
    if (prefix === 'private') return { kind: 'private', id }

    return { kind: 'other', id: key }
}

/** 表格里的会话排序：群在前、私聊在后 */
const KIND_ORDER: Record<string, number> = { group: 0, private: 1, other: 2 }

/**
 * 群管理页。
 *
 * ⚠️ 数据源是 `/sessions`（即 `state.json` 的订阅关系），**不是 `groupConfigs`**。
 * 本插件里 `groupConfigs` 只有会话级启用开关一个字段，而用户真正关心的是
 * "订阅了什么、收不收推送"（见 docs/design.md §13）。
 *
 * 通知开关**只读**：它的写入口是群里的 `notify on|off`（需要管理员权限）。在页面上
 * 摆一个点了没人处理的开关，就是这一页要避免的那种死 UI。
 */
export default function GroupsPage() {
    const [sessions, setSessions] = useState<SessionMap>({})
    const [groupNames, setGroupNames] = useState<Record<string, string>>({})
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState('')

    const fetchSessions = useCallback(async () => {
        setLoading(true)
        try {
            const res = await noAuthFetch<SessionMap>('/sessions')
            setSessions(res.code === 0 && res.data ? res.data : {})
        } catch {
            showToast('获取会话订阅失败', 'error')
        } finally {
            setLoading(false)
        }

        // 群名只是锦上添花：取不到就退回显示群号，不该为此报错
        try {
            const res = await noAuthFetch<GroupInfo[]>('/groups')
            if (res.code === 0 && res.data) {
                setGroupNames(
                    Object.fromEntries(res.data.map((g) => [String(g.group_id), g.group_name]))
                )
            }
        } catch {
            /* 忽略：群名缺失不影响订阅关系的展示 */
        }
    }, [])

    useEffect(() => { fetchSessions() }, [fetchSessions])

    const rows = Object.entries(sessions)
        .map(([key, record]) => {
            const { kind, id } = parseSessionKey(key)
            const name = kind === 'group' ? (groupNames[id] ?? '') : ''

            return { key, kind, id, name, record }
        })
        .sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.id.localeCompare(b.id))

    const filtered = rows.filter((row) => {
        if (!search) return true
        const q = search.toLowerCase()

        return (
            row.id.includes(q) ||
            row.name.toLowerCase().includes(q) ||
            row.record.enabledGames.some((game) => game.toLowerCase().includes(q))
        )
    })

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">加载会话订阅中...</div>
                </div>
            </div>
        )
    }

    const notified = rows.filter((row) => row.record.notifyEnabled).length

    return (
        <div className="space-y-4">
            {/* 工具栏 */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 animate-fade-in-down">
                <div className="relative flex-1 w-full sm:max-w-xs">
                    <IconSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                        className="input-field pl-9"
                        placeholder="搜索会话或已订阅的游戏..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <button className="btn btn-ghost text-xs" onClick={fetchSessions}>
                    <IconRefresh size={13} />
                    刷新
                </button>
            </div>

            {/* 统计 */}
            <p className="text-xs text-gray-400">
                共 {rows.length} 个会话，{notified} 个开启了通知
                {search && `，搜索到 ${filtered.length} 个`}
            </p>

            {/* 会话列表 */}
            <div className="card overflow-hidden animate-fade-in-up">
                <table className="w-full text-sm stagger-rows">
                    <thead>
                        <tr className="text-left text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-white/[0.02]">
                            <th className="py-2.5 px-4 font-medium">会话</th>
                            <th className="py-2.5 px-4 font-medium w-28">通知</th>
                            <th className="py-2.5 px-4 font-medium">已订阅游戏</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800/50">
                        {filtered.map((row) => (
                            <tr key={row.key} className="hover:bg-gray-50/50 dark:hover:bg-white/[0.02] transition-colors">
                                <td className="py-2.5 px-4">
                                    <div className="flex items-center gap-1.5 text-gray-800 dark:text-gray-200 font-medium">
                                        {row.kind === 'group' && <IconGroup size={13} className="text-gray-400" />}
                                        {row.name || (row.kind === 'private' ? '私聊' : row.kind === 'group' ? '未知群' : row.key)}
                                    </div>
                                    <div className="font-mono text-xs text-gray-500 mt-0.5">{row.id}</div>
                                </td>
                                <td className="py-2.5 px-4">
                                    {/* 只读徽章：写入口在群里的 `notify on|off` */}
                                    <span
                                        className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                                            row.record.notifyEnabled
                                                ? 'bg-emerald-500/10 text-emerald-500'
                                                : 'bg-gray-500/10 text-gray-400'
                                        }`}
                                    >
                                        {row.record.notifyEnabled ? <IconCheck size={11} /> : <IconX size={11} />}
                                        {row.record.notifyEnabled ? '已开启' : '已关闭'}
                                    </span>
                                </td>
                                <td className="py-2.5 px-4">
                                    {row.record.enabledGames.length === 0 ? (
                                        <span className="text-xs text-gray-400">未订阅</span>
                                    ) : (
                                        <div className="flex flex-wrap gap-1.5">
                                            {row.record.enabledGames.map((game) => (
                                                <span
                                                    key={game}
                                                    className="text-xs px-2 py-0.5 rounded-md bg-primary/10 text-primary"
                                                >
                                                    {game}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {filtered.length === 0 && (
                    <div className="py-12 text-center empty-state">
                        <p className="text-gray-400 text-sm">
                            {search ? '没有匹配的会话' : '还没有任何会话订阅'}
                        </p>
                        {!search && (
                            <p className="text-gray-400 text-xs mt-2">
                                在群里发 <code className="font-mono">#currency game add &lt;游戏名&gt;</code> 订阅游戏，
                                <code className="font-mono">#currency notify on</code> 开启推送
                            </p>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
