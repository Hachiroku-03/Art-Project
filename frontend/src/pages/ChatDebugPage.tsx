import { useState } from 'react'
import { useChat, isOptimistic } from '../hooks/useChat'

export function ChatDebugPage() {
  const viewer = localStorage.getItem('space_user') || ''
  const lang = 'en'

  const chat = useChat(viewer, lang)

  const [target, setTarget] = useState('')
  const [text, setText] = useState('')

  const cid = chat.activeConvId

  return (
    <main
      style={{
        minHeight: '100vh',
        paddingTop: 90,
        padding: '90px 1.5rem 2rem',
        background: '#f7f6f3',
        fontFamily: 'monospace',
        fontSize: 12,
      }}
    >
      <h2 style={{ fontFamily: 'sans-serif' }}>Chat Debug</h2>

      <p>
        viewer: <strong>{viewer}</strong> · online: <strong>{String(chat.online)}</strong>
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          value={target}
          onChange={e => setTarget(e.target.value)}
          placeholder="target username"
          style={{ padding: 6 }}
        />
        <button
          onClick={async () => {
            const d = await chat.startDirect(target.trim())
            if (d.error) alert(d.error)
          }}
        >
          Start direct
        </button>

        <button onClick={chat.refreshConversations}>Refresh conversations</button>
      </div>

      <h3>Conversations</h3>

      {chat.conversations.length === 0 ? (
        <p>No conversations yet.</p>
      ) : (
        <ul style={{ paddingLeft: 20 }}>
          {chat.conversations.map(c => (
            <li key={c.id} style={{ marginBottom: 6 }}>
              <button onClick={() => chat.openConversation(c.id)}>
                #{c.id} · {c.kind} · {c.counterpart || c.name || 'group'} · unread:{' '}
                {c.unread} · last: {c.last_body || '—'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {cid != null && (
        <>
          <h3>Active conversation #{cid}</h3>

          <p>typing: {chat.typingNames(cid).join(', ') || 'none'}</p>
          <p>read cursors: {JSON.stringify(chat.readCursors[cid] || {})}</p>

          <div
            style={{
              border: '1px solid #ccc',
              background: '#fff',
              maxHeight: 320,
              overflowY: 'auto',
              padding: 10,
              marginBottom: 10,
            }}
          >
            {chat.activeThread.length === 0 ? (
              <p>No messages yet.</p>
            ) : (
              chat.activeThread.map(t => {
                const key = isOptimistic(t) ? t.temp_id : String(t.id)
                const who = isOptimistic(t) ? viewer : t.sender
                const status = isOptimistic(t) ? ` [${t.status}]` : ''
                const translation =
                  !isOptimistic(t) && t.kind === 'text' && chat.translations[t.body]
                    ? ` → ${chat.translations[t.body]}`
                    : ''

                return (
                  <div key={key} style={{ marginBottom: 6 }}>
                    <strong>{who}</strong>
                    {status}: {t.kind} {t.body}
                    {translation}
                  </div>
                )
              })
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={text}
              onChange={e => {
                setText(e.target.value)
                chat.notifyTyping(cid)
              }}
              placeholder="type a message"
              style={{ flex: 1, padding: 6 }}
            />
            <button
              onClick={() => {
                const body = text.trim()
                if (!body) return
                chat.send(cid, 'text', body)
                setText('')
              }}
            >
              Send
            </button>
          </div>
        </>
      )}

      <hr style={{ margin: '20px 0' }} />

      <h3>Raw conversations JSON</h3>
      <pre style={{ whiteSpace: 'pre-wrap', background: '#fff', padding: 10 }}>
        {JSON.stringify(chat.conversations, null, 2)}
      </pre>

      <h3>Raw translations JSON</h3>
      <pre style={{ whiteSpace: 'pre-wrap', background: '#fff', padding: 10 }}>
        {JSON.stringify(chat.translations, null, 2)}
      </pre>
    </main>
  )
}