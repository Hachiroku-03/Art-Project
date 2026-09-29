import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, Ban, Bell, BellOff, Camera, Check, ChevronDown, FileText, Flag,
  Image as ImageIcon, Loader2, LogOut, Mic, Pencil, Plus, Shield, ShieldOff,
  Trash2, UserMinus, UserPlus, Users, Video, X,
} from 'lucide-react'
import { VoiceNote } from '../VoiceNote'
import {
  addMember, blockUser, demoteGroupMember, fetchConversationMedia,
  fetchConversationMembers, leaveConversation, listBlocks, promoteGroupMember,
  removeGroupMember, reportContent, unblockUser, updateConversation,
  updateConversationPrefs,
  type ChatMessage, type Conversation, type GroupMember,
} from '../../lib/chat'
import styles from './ChatInfoPanel.module.css'

type Tab = 'about' | 'members' | 'media' | 'files' | 'voice'
type Confirm = null | 'block' | 'leave' | 'delete'

const REPORT_REASONS = ['spam', 'harassment', 'hate speech', 'nudity', 'misinformation', 'other']

function parseDate(raw?: string | null) {
  if (!raw) return new Date(NaN)
  return new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
}
function fmtTime(raw?: string | null) {
  const d = parseDate(raw)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
function fromNow(raw?: string | null) {
  const d = parseDate(raw)
  if (isNaN(d.getTime())) return ''
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function firstLetter(name?: string | null) {
  return (name || '?')[0]?.toUpperCase() || '?'
}
function metaString(msg: ChatMessage | null, key: string, fallback = '') {
  if (!msg) return fallback
  const v = (msg.meta as Record<string, unknown> | undefined)?.[key]
  return v == null ? fallback : String(v)
}

function PanelAvatar({ src, name, className }: { src?: string | null; name?: string | null; className: string }) {
  return (
    <span className={className}>
      {src ? <img src={src} alt="" className={styles.avatarImg} /> : firstLetter(name)}
    </span>
  )
}

type Props = {
  viewer: string
  conversation: Conversation
  onClose: () => void
  onOpenImage: (url: string) => void
  onRefresh: () => void
  onArchived?: (archived: boolean) => void
  onConversationGone: () => void
}

export function ChatInfoPanel({
  viewer,
  conversation,
  onClose,
  onOpenImage,
  onRefresh,
  onArchived,
  onConversationGone,
}: Props) {
  const id = conversation.id
  const isGroup = conversation.kind === 'group'
  const counterpartUser = conversation.counterpart_username || ''

  const [tab, setTab] = useState<Tab>('about')
  const [members, setMembers] = useState<GroupMember[] | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [notice, setNotice] = useState('')

  const [mediaItems, setMediaItems] = useState<ChatMessage[]>([])
  const [mediaHasMore, setMediaHasMore] = useState(false)
  const [mediaLoading, setMediaLoading] = useState(false)
  const [mediaLoaded, setMediaLoaded] = useState(false)

  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(conversation.name || '')
  const [editingDesc, setEditingDesc] = useState(false)
  const [descVal, setDescVal] = useState(conversation.description || '')
  const [addMemberText, setAddMemberText] = useState('')
  const [expandedMember, setExpandedMember] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [reporting, setReporting] = useState(false)
  const [reportReason, setReportReason] = useState(REPORT_REASONS[0])
  const [reportDetails, setReportDetails] = useState('')
  const [busy, setBusy] = useState(false)

  const groupImgRef = useRef<HTMLInputElement>(null)

  const selfRole = useMemo(
    () => (members || []).find(m => m.user_name === viewer)?.role || 'member',
    [members, viewer],
  )
  const isOwner = selfRole === 'owner'
  const canManage = isOwner || selfRole === 'admin'

  const counterpartMember = useMemo(() => {
    if (isGroup) return null
    return (members || []).find(m => (counterpartUser ? m.user_name === counterpartUser : m.user_name !== viewer)) || null
  }, [members, isGroup, counterpartUser, viewer])

  const loadMembers = useCallback(() => {
    fetchConversationMembers(viewer, id)
      .then(setMembers)
      .catch(() => setMembers([]))
  }, [viewer, id])

  const loadBlocks = useCallback(() => {
    if (isGroup || !counterpartUser) { setBlocked(false); return }
    listBlocks(viewer)
      .then(rows => setBlocked(rows.some(b => (b.blocked || '').toLowerCase() === counterpartUser.toLowerCase())))
      .catch(() => setBlocked(false))
  }, [viewer, isGroup, counterpartUser])

  // (Re)load whenever the conversation changes; reset transient UI.
  useEffect(() => {
    setTab('about')
    setMembers(null)
    setNotice('')
    setEditingName(false); setNameVal(conversation.name || '')
    setEditingDesc(false); setDescVal(conversation.description || '')
    setAddMemberText(''); setExpandedMember(null); setConfirm(null); setReporting(false)
    setMediaItems([]); setMediaHasMore(false); setMediaLoaded(false)
    loadMembers()
    loadBlocks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const ensureMedia = useCallback(() => {
    if (mediaLoaded || mediaLoading) return
    setMediaLoading(true)
    fetchConversationMedia(viewer, id, 'all', 0, 100)
      .then(d => { setMediaItems(d.messages || []); setMediaHasMore(!!d.has_more); setMediaLoaded(true) })
      .catch(() => { setMediaItems([]); setMediaHasMore(false); setMediaLoaded(true) })
      .finally(() => setMediaLoading(false))
  }, [viewer, id, mediaLoaded, mediaLoading])

  // Lazily fetch the gallery the first time a media-ish tab is opened.
  useEffect(() => {
    if (tab === 'media' || tab === 'files' || tab === 'voice') ensureMedia()
  }, [tab, ensureMedia])

  const loadMoreMedia = useCallback(() => {
    if (!mediaHasMore || mediaLoading || !mediaItems.length) return
    setMediaLoading(true)
    const oldest = mediaItems[mediaItems.length - 1].id
    fetchConversationMedia(viewer, id, 'all', oldest, 100)
      .then(d => { setMediaItems(prev => [...prev, ...(d.messages || [])]); setMediaHasMore(!!d.has_more) })
      .catch(() => {})
      .finally(() => setMediaLoading(false))
  }, [viewer, id, mediaHasMore, mediaLoading, mediaItems])

  const mediaImages = useMemo(() => mediaItems.filter(m => m.kind === 'image' || m.kind === 'video'), [mediaItems])
  const mediaFiles = useMemo(() => mediaItems.filter(m => m.kind === 'file'), [mediaItems])
  const mediaVoices = useMemo(() => mediaItems.filter(m => m.kind === 'voice'), [mediaItems])

  const act = useCallback(async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true); setNotice('')
    try {
      const d = await fn()
      if (d && d.error) { setNotice(d.error); return false }
      if (ok) setNotice(ok)
      return true
    } catch {
      setNotice('Network error.')
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const toggleMute = () => act(() => updateConversationPrefs(viewer, id, { muted: !conversation.muted })).then(onRefresh)
const toggleArchive = async () => {
  const next = !conversation.archived
  const ok = await act(() => updateConversationPrefs(viewer, id, { archived: next }))

  if (ok) {
    onRefresh()
    onArchived?.(next)
  }
}

  const doBlock = async () => {
    const ok = await act(() => blockUser(viewer, counterpartUser))
    if (ok) { setBlocked(true); setConfirm(null); onRefresh() }
  }
  const doUnblock = async () => {
    const ok = await act(() => unblockUser(viewer, counterpartUser))
    if (ok) { setBlocked(false); onRefresh() }
  }
  const submitReport = async () => {
    const payload = isGroup
      ? { viewer, target_type: 'conversation' as const, target_id: id, reason: reportReason, details: reportDetails }
      : { viewer, target_type: 'user' as const, target_text: counterpartUser, reason: reportReason, details: reportDetails }
    const ok = await act(() => reportContent(payload), 'Report submitted.')
    if (ok) { setReporting(false); setReportDetails('') }
  }

  const doLeave = async () => {
    const ok = await act(() => leaveConversation(viewer, id))
    if (ok) onConversationGone()
  }
  const doDeleteGroup = async () => {
    const ok = await act(async () => {
      const { deleteGroup } = await import('../../lib/chat')
      return deleteGroup(viewer, id)
    })
    if (ok) onConversationGone()
  }

  const saveName = async () => {
    const v = nameVal.trim()
    if (!v) { setNotice('Name cannot be empty.'); return }
    const ok = await act(() => updateConversation(viewer, id, { name: v }))
    if (ok) { setEditingName(false); onRefresh() }
  }
  const saveDesc = async () => {
    const ok = await act(() => updateConversation(viewer, id, { description: descVal.trim() || null }))
    if (ok) { setEditingDesc(false); onRefresh() }
  }
  const onGroupImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    setBusy(true); setNotice('')
    const form = new FormData(); form.append('file', file)
    try {
      const API = (await import('../../lib/sales')).API
      const d = await fetch(`${API}/upload`, { method: 'POST', body: form }).then(r => r.json())
      if (!d.url) { setNotice('Upload failed.'); return }
      const ok = await act(() => updateConversation(viewer, id, { image_url: d.url }))
      if (ok) onRefresh()
    } catch {
      setNotice('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  const doAddMember = async () => {
    const name = addMemberText.trim().replace(/^@/, '')
    if (!name) return
    const ok = await act(() => addMember(viewer, id, name))
    if (ok) { setAddMemberText(''); loadMembers(); onRefresh() }
  }
  const doRemove = async (userName: string) => {
    const ok = await act(() => removeGroupMember(viewer, id, userName))
    if (ok) { setExpandedMember(null); loadMembers(); onRefresh() }
  }
  const doPromote = async (userName: string) => {
    const ok = await act(() => promoteGroupMember(viewer, id, userName))
    if (ok) { setExpandedMember(null); loadMembers() }
  }
  const doDemote = async (userName: string) => {
    const ok = await act(() => demoteGroupMember(viewer, id, userName))
    if (ok) { setExpandedMember(null); loadMembers() }
  }

  const title = isGroup ? conversation.name || 'Group' : conversation.counterpart || 'Direct message'
  const heroAvatar = isGroup ? conversation.image_url : counterpartMember?.avatar_url || conversation.counterpart_avatar
  const heroSub = isGroup
    ? `${members?.length ?? conversation.member_count ?? 0} members`
    : counterpartMember?.online
      ? 'online'
      : counterpartMember?.last_seen_at
        ? `last seen ${fromNow(counterpartMember.last_seen_at)}`
        : `@${counterpartUser || '—'}`

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'about', label: 'About' },
    ...(isGroup ? [{ key: 'members' as Tab, label: 'Members', count: members?.length }] : []),
    { key: 'media', label: 'Media', count: mediaImages.length || undefined },
    { key: 'files', label: 'Files', count: mediaFiles.length || undefined },
    { key: 'voice', label: 'Voice', count: mediaVoices.length || undefined },
  ]

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.panel} role="dialog" aria-label="Chat info">
        <div className={styles.topbar}>
          <span className={styles.topTitle}>{isGroup ? 'Group info' : 'Contact info'}</span>
          <button className={styles.iconBtn} onClick={onClose} aria-label="Close info"><X size={18} /></button>
        </div>

        <div className={styles.hero}>
          <div className={styles.heroAvatarWrap}>
            <PanelAvatar src={heroAvatar} name={title} className={styles.bigAvatar} />
            {isGroup && canManage && (
              <button className={styles.camBtn} onClick={() => groupImgRef.current?.click()} aria-label="Change group photo">
                <Camera size={14} />
              </button>
            )}
            <input ref={groupImgRef} type="file" accept="image/*" className={styles.hiddenInput} onChange={onGroupImage} />
          </div>
          <h2 className={styles.heroName}>{title}</h2>
          <p className={styles.heroSub}>
            {!isGroup && counterpartMember?.online && <span className={styles.onlineDot} />}
            {heroSub}
          </p>
        </div>

        <div className={styles.quickRow}>
          <button className={`${styles.quickBtn} ${conversation.muted ? styles.quickBtnOn : ''}`} onClick={toggleMute} disabled={busy}>
            {conversation.muted ? <BellOff size={15} /> : <Bell size={15} />}
            <span>{conversation.muted ? 'Unmute' : 'Mute'}</span>
          </button>
          <button className={`${styles.quickBtn} ${conversation.archived ? styles.quickBtnOn : ''}`} onClick={toggleArchive} disabled={busy}>
            <Archive size={15} />
            <span>{conversation.archived ? 'Unarchive' : 'Archive'}</span>
          </button>
        </div>

        {notice && <p className={styles.notice}>{notice}</p>}

        <div className={styles.tabs} role="tablist">
          {tabs.map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`${styles.tab} ${tab === t.key ? styles.tabOn : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.count != null && t.count > 0 && <span className={styles.tabCount}>{t.count}</span>}
            </button>
          ))}
        </div>

        <div className={styles.content}>
          {tab === 'about' && (
            <div className={styles.about}>
              {isGroup ? (
                <>
                  <div className={styles.aboutBlock}>
                    <div className={styles.aboutHead}>
                      <span className={styles.aboutLabel}>Group name</span>
                      {canManage && !editingName && (
                        <button className={styles.inlineBtn} onClick={() => { setNameVal(conversation.name || ''); setEditingName(true) }}><Pencil size={13} /> Edit</button>
                      )}
                    </div>
                    {editingName ? (
                      <div className={styles.editRow}>
                        <input className={styles.editInput} value={nameVal} onChange={e => setNameVal(e.target.value)} maxLength={80} />
                        <button className={styles.editOk} onClick={saveName} disabled={busy} aria-label="Save name"><Check size={15} /></button>
                        <button className={styles.editCancel} onClick={() => setEditingName(false)} aria-label="Cancel"><X size={15} /></button>
                      </div>
                    ) : (
                      <p className={styles.aboutValue}>{conversation.name || '—'}</p>
                    )}
                  </div>

                  <div className={styles.aboutBlock}>
                    <div className={styles.aboutHead}>
                      <span className={styles.aboutLabel}>Description</span>
                      {canManage && !editingDesc && (
                        <button className={styles.inlineBtn} onClick={() => { setDescVal(conversation.description || ''); setEditingDesc(true) }}><Pencil size={13} /> Edit</button>
                      )}
                    </div>
                    {editingDesc ? (
                      <div className={styles.editRowCol}>
                        <textarea className={styles.editArea} rows={3} value={descVal} onChange={e => setDescVal(e.target.value)} maxLength={300} />
                        <div className={styles.editBtns}>
                          <button className={styles.smallPrimary} onClick={saveDesc} disabled={busy}>Save</button>
                          <button className={styles.smallGhost} onClick={() => setEditingDesc(false)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <p className={styles.aboutValue}>{conversation.description || 'No description.'}</p>
                    )}
                  </div>

                  <div className={styles.dangerList}>
                    <button className={styles.dangerBtn} onClick={() => setConfirm(confirm === 'leave' ? null : 'leave')} disabled={busy}>
                      <LogOut size={15} /> Leave group
                    </button>
                    {confirm === 'leave' && (
                      <div className={styles.confirmRow}>
                        <span>Leave this group?</span>
                        <button className={styles.smallGhost} onClick={() => setConfirm(null)}>Cancel</button>
                        <button className={styles.smallDanger} onClick={doLeave} disabled={busy}>Leave</button>
                      </div>
                    )}
                    {isOwner && (
                      <>
                        <button className={`${styles.dangerBtn} ${styles.dangerBtnDanger}`} onClick={() => setConfirm(confirm === 'delete' ? null : 'delete')} disabled={busy}>
                          <Trash2 size={15} /> Delete group
                        </button>
                        {confirm === 'delete' && (
                          <div className={styles.confirmRow}>
                            <span>Delete for everyone? This cannot be undone.</span>
                            <button className={styles.smallGhost} onClick={() => setConfirm(null)}>Cancel</button>
                            <button className={styles.smallDanger} onClick={doDeleteGroup} disabled={busy}>Delete</button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.aboutRow}><span className={styles.aboutLabel}>Username</span><span className={styles.aboutValue}>@{counterpartUser || '—'}</span></div>
                  <div className={styles.aboutRow}><span className={styles.aboutLabel}>Status</span><span className={styles.aboutValue}>{heroSub}</span></div>

                  <div className={styles.dangerList}>
                    {blocked ? (
                      <button className={styles.dangerBtn} onClick={doUnblock} disabled={busy}><Ban size={15} /> Unblock user</button>
                    ) : (
                      <>
                        <button className={styles.dangerBtn} onClick={() => setConfirm(confirm === 'block' ? null : 'block')} disabled={busy}><Ban size={15} /> Block user</button>
                        {confirm === 'block' && (
                          <div className={styles.confirmRow}>
                            <span>Blocking stops messages both ways.</span>
                            <button className={styles.smallGhost} onClick={() => setConfirm(null)}>Cancel</button>
                            <button className={styles.smallDanger} onClick={doBlock} disabled={busy}>Block</button>
                          </div>
                        )}
                      </>
                    )}
                    <button className={styles.dangerBtn} onClick={() => setReporting(r => !r)} disabled={busy}><Flag size={15} /> Report user</button>
                  </div>
                </>
              )}

              {reporting && (
                <div className={styles.reportBox}>
                  <label className={styles.aboutLabel}>Reason</label>
                  <select className={styles.editInput} value={reportReason} onChange={e => setReportReason(e.target.value)}>
                    {REPORT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <textarea className={styles.editArea} rows={2} placeholder="Add details (optional)" value={reportDetails} onChange={e => setReportDetails(e.target.value)} />
                  <div className={styles.editBtns}>
                    <button className={styles.smallPrimary} onClick={submitReport} disabled={busy}>Submit report</button>
                    <button className={styles.smallGhost} onClick={() => setReporting(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'members' && isGroup && (
            <div className={styles.members}>
              {members === null ? (
                <div className={styles.center}><Loader2 size={18} className={styles.spin} /></div>
              ) : (
                <>
                  {canManage && (
                    <div className={styles.addRow}>
                      <input className={styles.addInput} value={addMemberText} onChange={e => setAddMemberText(e.target.value)} placeholder="username to add" />
                      <button className={styles.addBtn} onClick={doAddMember} disabled={busy || !addMemberText.trim()} aria-label="Add member"><Plus size={15} /></button>
                    </div>
                  )}
                  <ul className={styles.memberList}>
                    {members.map(m => {
                      const isSelf = m.user_name === viewer
                      const targetOwner = m.role === 'owner'
                      const canRemove = canManage && !isSelf && !targetOwner
                      const canPromote = isOwner && !isSelf && !targetOwner && m.role === 'member'
                      const canDemote = isOwner && !isSelf && m.role === 'admin'
                      const open = expandedMember === m.user_name
                      return (
                        <li key={m.user_name} className={styles.memberItem}>
                          <button className={styles.memberRow} onClick={() => setExpandedMember(open ? null : m.user_name)} disabled={!(canRemove || canPromote || canDemote)}>
                            <span className={styles.memberAvatarWrap}>
                              <PanelAvatar src={m.avatar_url} name={m.display_name || m.user_name} className={styles.memberAvatar} />
                              {m.online && <span className={styles.memberOnline} />}
                            </span>
                            <span className={styles.memberMid}>
                              <span className={styles.memberName}>{m.display_name || m.user_name}{isSelf && ' (you)'}</span>
                              <span className={styles.memberMeta}>@{m.user_name}</span>
                            </span>
                            <span className={`${styles.roleBadge} ${m.role === 'owner' ? styles.roleOwner : m.role === 'admin' ? styles.roleAdmin : styles.roleMember}`}>{m.role}</span>
                            {(canRemove || canPromote || canDemote) && <ChevronDown size={15} className={`${styles.chev} ${open ? styles.chevOn : ''}`} />}
                          </button>
                          {open && (
                            <div className={styles.manageRow}>
                              {canPromote && <button className={styles.manageBtn} onClick={() => doPromote(m.user_name)} disabled={busy}><Shield size={13} /> Make admin</button>}
                              {canDemote && <button className={styles.manageBtn} onClick={() => doDemote(m.user_name)} disabled={busy}><ShieldOff size={13} /> Remove admin</button>}
                              {canRemove && <button className={`${styles.manageBtn} ${styles.manageDanger}`} onClick={() => doRemove(m.user_name)} disabled={busy}><UserMinus size={13} /> Remove</button>}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </div>
          )}

          {(tab === 'media' || tab === 'files' || tab === 'voice') && (
            <div className={styles.gallery}>
              {mediaLoading && !mediaItems.length ? (
                <div className={styles.center}><Loader2 size={18} className={styles.spin} /></div>
              ) : tab === 'media' ? (
                mediaImages.length ? (
                  <div className={styles.grid}>
                    {mediaImages.map(m => m.kind === 'image' ? (
                      <button key={m.id} className={styles.gridItem} onClick={() => onOpenImage(m.body)} aria-label="Open image">
                        <img src={m.body} alt="" className={styles.gridImg} loading="lazy" />
                      </button>
                    ) : (
                      <div key={m.id} className={styles.gridItem}>
                        <video src={m.body} controls muted playsInline className={styles.gridVideo} />
                      </div>
                    ))}
                  </div>
                ) : <p className={styles.empty}>No photos or videos yet.</p>
              ) : tab === 'files' ? (
                mediaFiles.length ? (
                  <ul className={styles.fileList}>
                    {mediaFiles.map(m => (
                      <li key={m.id}>
                        <a href={m.body} download={metaString(m, 'file_name', 'File')} target="_blank" rel="noreferrer" className={styles.fileRow}>
                          <span className={styles.fileIcon}><FileText size={18} /></span>
                          <span className={styles.fileInfo}>
                            <strong>{metaString(m, 'file_name', 'File')}</strong>
                            <em>{[metaString(m, 'file_size'), fmtTime(m.created_at)].filter(Boolean).join(' · ')}</em>
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : <p className={styles.empty}>No files yet.</p>
              ) : (
                mediaVoices.length ? (
                  <ul className={styles.voiceList}>
                    {mediaVoices.map(m => (
                      <li key={m.id} className={styles.voiceRow}>
                        <span className={styles.voiceFrom}>{m.sender_display || m.sender}</span>
                        <VoiceNote src={m.body} seed={m.id} />
                      </li>
                    ))}
                  </ul>
                ) : <p className={styles.empty}>No voice notes yet.</p>
              )}

              {mediaHasMore && (tab === 'media' ? mediaImages.length : tab === 'files' ? mediaFiles.length : mediaVoices.length) > 0 && (
                <button className={styles.loadMore} onClick={loadMoreMedia} disabled={mediaLoading}>
                  {mediaLoading ? <Loader2 size={14} className={styles.spin} /> : null} Load older
                </button>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}